// Banco de ejemplo: ingreso y apertura de cuenta con la wallet, sin contraseñas.
//
//   Ingresar     la wallet presenta cédula y nombre; si hay un cliente con esa
//                cédula, entra.
//   Abrir cuenta la wallet presenta cédula, nombre, fecha de nacimiento, correo,
//                foto y vencimiento del PID; si es mayor de edad, el PID está
//                vigente y no es cliente, se le crea la cuenta (clientes.json).
//
// La verificación (firma, emisor de confianza, estado, prueba de posesión) la
// hace el verifier de su instancia (../_comun/levantar.sh banco); aquí solo se decide
// qué pedir y qué hacer con los datos.
//
// Variables de entorno (las pone compose.yml a partir de .env):
//   URL_PUBLICA       URL con la que la ve el navegador. Ej.: https://civica-desarrollo.avance.org.co/banco
//                     El servidor escucha bajo su ruta (srv-nw-nginx no quita el prefijo).
//   VERIFIER_API      API del verifier por la red interna. Ej.: http://verifier-banco/verifier-banco
//   NOMBRE_BANCO      el nombre que se muestra
//   CLIENTES_ARCHIVO  archivo JSON de clientes (se crea vacío si no existe)
//   PUERTO            puerto interno (80: srv-nw-nginx llama a app-banco:80)

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import QRCode from 'qrcode'
import { crearClientes } from './clientes.js'
import { crearVerifier } from './verifier.js'

const requerida = (nombre) => {
  const valor = process.env[nombre]
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre}`)
  return valor
}

const URL_PUBLICA = requerida('URL_PUBLICA').replace(/\/$/, '')
const BASE = new URL(URL_PUBLICA).pathname.replace(/\/$/, '')
const NOMBRE = process.env.NOMBRE_BANCO ?? 'Banco Cívica'
const PUERTO = Number(process.env.PUERTO ?? 80)
const VENCE_SOLICITUD_MS = 5 * 60 * 1000

const verifier = crearVerifier({ api: requerida('VERIFIER_API') })
const clientes = crearClientes(process.env.CLIENTES_ARCHIVO ?? '/datos/clientes.json')

// Qué se le pide a la wallet en cada caso (datos de primer nivel del PID de la Registraduría).
//
// Solo se piden datos que el PID trae SIEMPRE: si la consulta incluye un dato que el documento no
// tiene, la wallet no encuentra ningun documento que la cumpla ("documento no disponible"). Este PID
// no lleva `email` ni `date_of_expiry` (la Registraduria no los emite), por eso no se piden.
const PEDIDOS = {
  ingreso: ['personal_administrative_number', 'given_name', 'family_name'],
  registro: ['personal_administrative_number', 'given_name', 'family_name', 'birthdate', 'picture'],
}

// --- Sesiones y solicitudes en memoria (es un ejemplo: se pierden al reiniciar) -----------
const sesiones = new Map()     // id → { cedula?, pendiente? }
const solicitudes = new Map()  // id → { tipo, transaccion, sesion, creada, final? }

function sesion(req, res) {
  const id = /(?:^|;\s*)banco_sesion=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1]
  if (id && sesiones.has(id)) return sesiones.get(id)
  const nueva = randomBytes(24).toString('base64url')
  sesiones.set(nueva, { id: nueva })
  res.append('Set-Cookie', `banco_sesion=${nueva}; Path=${BASE || '/'}; HttpOnly; Secure; SameSite=Lax`)
  return sesiones.get(nueva)
}

setInterval(() => {
  const limite = Date.now() - 30 * 60 * 1000
  for (const [id, s] of solicitudes) if (s.creada < limite) solicitudes.delete(id)
}, 60 * 1000).unref()

// --- Qué hacer con los datos verificados ---------------------------------------------------
const hoy = () => new Date().toISOString().slice(0, 10)
function edad(nacimiento) {
  const n = new Date(nacimiento)
  const h = new Date()
  return h.getFullYear() - n.getFullYear() - (h < new Date(h.getFullYear(), n.getMonth(), n.getDate()) ? 1 : 0)
}

function completar(solicitud, { datos, emisor }) {
  const cedula = datos.personal_administrative_number
  if (!cedula) return { estado: 'rechazada', motivo: 'La wallet no compartió tu número de documento.' }
  const s = sesiones.get(solicitud.sesion)

  if (solicitud.tipo === 'ingreso') {
    const cliente = clientes.registrarIngreso(String(cedula))
    if (!cliente) {
      return { estado: 'rechazada', motivo: `No tenemos una cuenta para el documento ${cedula}. Ábrela con tu wallet en un minuto.` }
    }
    if (s) s.cedula = cliente.cedula
    console.log(`[ingreso] ${cliente.cedula} (${cliente.nombres}), PID de ${emisor}`)
    return { estado: 'listo', destino: `${BASE}/cuenta` }
  }

  // Apertura de cuenta: las reglas del banco sobre los datos verificados.
  for (const d of ['given_name', 'family_name', 'birthdate']) {
    if (!datos[d]) return { estado: 'rechazada', motivo: `La wallet no compartió un dato necesario (${d}).` }
  }
  if (edad(datos.birthdate) < 18) return { estado: 'rechazada', motivo: 'Para abrir una cuenta tienes que ser mayor de edad.' }
  if (datos.date_of_expiry && datos.date_of_expiry < hoy()) {
    return { estado: 'rechazada', motivo: `Tu documento venció el ${datos.date_of_expiry}. Pide uno nuevo en tu wallet.` }
  }
  if (clientes.buscar(String(cedula))) {
    return { estado: 'rechazada', motivo: 'Ya tienes una cuenta con nosotros: ingresa con tu wallet.' }
  }
  const cliente = clientes.crear({
    cedula: String(cedula),
    nombres: datos.given_name,
    apellidos: datos.family_name,
    fecha_nacimiento: datos.birthdate,
    correo: datos.email ?? null,
    foto: typeof datos.picture === 'string' && datos.picture.startsWith('data:image/') ? datos.picture : null,
    // De dónde salieron los datos: el emisor del PID y cuándo se verificó.
    verificacion: { emisor, pid_vence: datos.date_of_expiry ?? null, fecha: new Date().toISOString() },
  })
  if (s) s.cedula = cliente.cedula
  console.log(`[registro] ${cliente.cedula} (${cliente.nombres} ${cliente.apellidos}), cuenta ${cliente.cuenta}, PID de ${emisor}`)
  return { estado: 'listo', destino: `${BASE}/cuenta`, nuevo: true }
}

async function consultar(solicitud, responseCode) {
  if (solicitud.final) return solicitud.final
  const r = await verifier.resultado(solicitud.transaccion, responseCode)
  if (r.estado === 'esperando') {
    if (Date.now() - solicitud.creada > VENCE_SOLICITUD_MS) {
      solicitud.final = { estado: 'rechazada', motivo: 'La solicitud venció. Inténtalo de nuevo.' }
    }
    return solicitud.final ?? r
  }
  if (r.estado === 'error') {
    console.log(`[${solicitud.tipo}] rechazada por el verifier: ${r.motivo}${r.detalle ? ` (${JSON.stringify(r.detalle)})` : ''}`)
    solicitud.final = { estado: 'rechazada', motivo: `No se pudo verificar: ${r.motivo}.` }
  } else {
    solicitud.final = completar(solicitud, r)
  }
  return solicitud.final
}

// --- Rutas --------------------------------------------------------------------------------
const app = express()
app.disable('x-powered-by')
app.use(express.json())
const r = express.Router()

const pagina = (archivo) => readFileSync(new URL(`./publico/${archivo}`, import.meta.url), 'utf8')
  .replaceAll('{{BASE}}', BASE).replaceAll('{{NOMBRE}}', NOMBRE)
const paginas = { inicio: pagina('index.html'), cuenta: pagina('cuenta.html') }

// La hoja de estilo va aparte, para que la identidad visual (los tokens de NU
// Colombia) esté en un solo sitio y las dos páginas no la repitan.
const ESTILO = readFileSync(new URL('./publico/estilo.css', import.meta.url), 'utf8')

r.get('/salud', (_req, res) => res.json({ estado: 'ok' }))
r.get('/estilo.css', (_req, res) => res.type('text/css').set('cache-control', 'no-cache').send(ESTILO))
r.get('/', (req, res) => { sesion(req, res); res.type('html').send(paginas.inicio) })
r.get('/cuenta', (req, res) => {
  if (!sesion(req, res).cedula) return res.redirect(`${BASE}/`)
  res.type('html').send(paginas.cuenta)
})

// Empieza un ingreso o una apertura: devuelve el QR y el enlace para la wallet.
r.post('/api/solicitud', async (req, res) => {
  const { tipo, dispositivo } = req.body ?? {}
  if (!PEDIDOS[tipo]) return res.status(400).json({ error: 'tipo: ingreso o registro' })
  const s = sesion(req, res)
  try {
    const { transaccion, enlace } = await verifier.crearSolicitud({
      datos: PEDIDOS[tipo],
      nonce: randomBytes(16).toString('base64url'),
      // En el mismo teléfono la wallet vuelve al banco al terminar.
      redireccion: dispositivo === 'mismo' ? `${URL_PUBLICA}/volver` : undefined,
    })
    const id = randomBytes(16).toString('base64url')
    solicitudes.set(id, { tipo, transaccion, sesion: s.id, creada: Date.now() })
    s.pendiente = id
    res.json({ id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 320 }) })
  } catch (e) {
    console.error(`[${tipo}] ${e.message}`)
    res.status(503).json({ error: 'El servicio de verificación no está disponible. Inténtalo en unos minutos.' })
  }
})

// El navegador pregunta cada par de segundos (en el computador, mientras se escanea el QR).
r.get('/api/solicitud/:id', async (req, res) => {
  const solicitud = solicitudes.get(req.params.id)
  if (!solicitud || solicitud.sesion !== sesion(req, res).id) return res.status(404).json({ estado: 'rechazada', motivo: 'Solicitud desconocida.' })
  try {
    res.json(await consultar(solicitud))
  } catch (e) {
    console.error(`[${solicitud.tipo}] ${e.message}`)
    res.json({ estado: 'esperando' })
  }
})

// A donde vuelve la wallet en el mismo teléfono, con el código que libera el resultado.
r.get('/volver', async (req, res) => {
  const s = sesion(req, res)
  const solicitud = solicitudes.get(s.pendiente)
  const fallo = (motivo) => res.redirect(`${BASE}/?error=${encodeURIComponent(motivo)}`)
  if (!solicitud || !req.query.response_code) return fallo('No encontramos la solicitud. Inténtalo de nuevo desde este navegador.')
  try {
    const final = await consultar(solicitud, String(req.query.response_code))
    if (final.estado === 'listo') return res.redirect(final.destino + (final.nuevo ? '?nueva=1' : ''))
    return fallo(final.motivo ?? 'La wallet todavía no ha respondido.')
  } catch (e) {
    console.error(`[volver] ${e.message}`)
    return fallo('El servicio de verificación no está disponible.')
  }
})

r.get('/api/yo', (req, res) => {
  const cedula = sesion(req, res).cedula
  const cliente = cedula && clientes.buscar(cedula)
  if (!cliente) return res.status(401).json({ error: 'sin sesión' })
  res.json(cliente)
})

r.post('/api/salir', (req, res) => {
  delete sesion(req, res).cedula
  res.json({ ok: true })
})

app.use(BASE || '/', r)
app.listen(PUERTO, () => console.log(`${NOMBRE} escuchando en :${PUERTO}${BASE} (verifier ${process.env.VERIFIER_API})`))
