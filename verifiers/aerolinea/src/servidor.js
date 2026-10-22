// Aerolínea de ejemplo (Páramo Air): vende pasajes, identifica al pasajero con su PID, emite el tiquete a la wallet y lo
// verifica en el embarque. Muestra las dos caras del ecosistema en un mismo servicio:
//
//   Verifier   Antes de vender, la persona se identifica presentando su PID desde la wallet: nombre, documento, fecha de
//              nacimiento (para clasificarla como adulto, niño o infante) y foto, que son los datos de seguridad que una
//              aerolínea necesita porque el tiquete es nominal e intransferible. En el embarque se pide el tiquete y el PID
//              juntos (dos credenciales en un solo código) y se comprueba que son de la misma persona.
//   Emisor     El tiquete se entrega como un documento de la wallet (SD-JWT VC por OpenID4VCI), firmado por la aerolínea,
//              registrado en la lista QEAA y anulable con su status list (cancelar el tiquete lo revoca).
//
// Variables de entorno (las pone compose.yml a partir de .env):
//   URL_PUBLICA          https://civica-desarrollo.avance.org.co/aerolinea (también es el credential_issuer)
//   VERIFIER_API         http://verifier-aerolinea/verifier-aerolinea (red interna)
//   TRUST_VALIDATOR_URL  a quién pregunta si la WIA de una wallet es de un wallet-provider de confianza
//   AEROLINEA_NOMBRE     el nombre que se muestra
//   AEROLINEA_CODIGO     código de los números de vuelo
//   SECRETOS_DIR         ds.crt y ds.key (certificado y clave de firma)
//   TRAMITES_ARCHIVO     el archivo de reservas (datos/tramites.json)
//   PUERTO               80 (el nginx central llama a <prefijo>:80)

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import { importPKCS8 } from 'jose'
import QRCode from 'qrcode'
import { crearAbca } from './abca.js'
import { DOCUMENTOS } from './documentos.js'
import { crearEmisor } from './emisor.js'
import { crearEstado } from './estado.js'
import { crearTramites } from './tramites.js'
import { crearVerifier } from './verifier.js'
import { CIUDADES, INTERNACIONAL, OFERTAS, TARIFAS, buscar, categoria, cop, precio } from './vuelos.js'

const requerida = (n) => process.env[n] || (() => { throw new Error(`Falta la variable de entorno ${n}`) })()
const URL_PUBLICA = requerida('URL_PUBLICA').replace(/\/$/, '')
const BASE = new URL(URL_PUBLICA).pathname.replace(/\/$/, '')
const SECRETOS = process.env.SECRETOS_DIR ?? '/secretos'
const CODIGO = process.env.AEROLINEA_CODIGO ?? 'PMO'
const aerolinea = { nombre: process.env.AEROLINEA_NOMBRE ?? 'Páramo Air', codigo: CODIGO }
const VENCE_SOLICITUD_MS = 5 * 60 * 1000
const VCT_PID = 'urn:eudi:pid:1'
const VCT_TIQUETE = DOCUMENTOS.tiquete.vct

// --- Piezas --------------------------------------------------------------------------------
const certificado = readFileSync(`${SECRETOS}/ds.crt`, 'utf8')
const firmante = {
  clave: await importPKCS8(readFileSync(`${SECRETOS}/ds.key`, 'utf8'), 'ES256'),
  x5c: [certificado.replace(/-----[^-]+-----|\s/g, '')],
}
const tramites = crearTramites(process.env.TRAMITES_ARCHIVO ?? '/datos/tramites.json')
const estado = crearEstado({ firmante, uri: `${URL_PUBLICA}/estado/1`, anulados: tramites.anulados })
const abca = crearAbca({ trustValidator: requerida('TRUST_VALIDATOR_URL'), audiencia: URL_PUBLICA })
const emisor = crearEmisor({ url: URL_PUBLICA, aerolinea, firmante, tramites, estado, abca, trustValidator: process.env.TRUST_VALIDATOR_URL })
const verifier = crearVerifier({ api: requerida('VERIFIER_API') })

// --- Sesiones y solicitudes al verifier (en memoria: es un ejemplo) -------------------------
const sesiones = new Map()
const solicitudes = new Map() // id → { proposito: 'identificacion' | 'embarque', transaccion, sesion, creada, demo?, final? }

function sesion(req, res) {
  const id = /(?:^|;\s*)aerolinea_sesion=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1]
  if (id && sesiones.has(id)) return sesiones.get(id)
  const nueva = randomBytes(24).toString('base64url')
  sesiones.set(nueva, { id: nueva })
  res.append('Set-Cookie', `aerolinea_sesion=${nueva}; Path=${BASE || '/'}; HttpOnly; Secure; SameSite=Lax`)
  return sesiones.get(nueva)
}
setInterval(() => {
  const limite = Date.now() - 30 * 60 * 1000
  for (const [id, s] of solicitudes) if (s.creada < limite) solicitudes.delete(id)
}, 60 * 1000).unref()

// Qué se le pide a la wallet. La foto va como data URI; solo se acepta una imagen real (se pone en un <img>).
const FOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/
const PEDIDOS = {
  // Datos de seguridad del pasajero: nombre, documento, fecha de nacimiento (categoría y edad) y foto.
  identificacion: () => [{ id: 'pid', vct: VCT_PID, datos: ['personal_administrative_number', 'given_name', 'family_name', 'birthdate', 'picture'] }],
  // Embarque: el tiquete y el documento de identidad, juntos.
  embarque: () => [
    { id: 'tiquete', vct: VCT_TIQUETE, datos: ['reserva', 'numero_tiquete', 'pasajero_nombre', 'pasajero_documento', 'vuelo', 'origen', 'destino', 'fecha_salida', 'hora_salida', 'tarifa', 'categoria_pasajero'] },
    { id: 'pid', vct: VCT_PID, datos: ['personal_administrative_number', 'given_name', 'family_name', 'picture'] },
  ],
}
const normal = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()

function completar(solicitud, r) {
  const pid = r.credenciales.pid
  if (!pid || pid.vct !== VCT_PID) return { estado: 'rechazada', motivo: 'Falta el documento de identidad digital (PID).' }
  const d = pid.datos
  if (!d.personal_administrative_number || !d.given_name || !d.family_name) {
    return { estado: 'rechazada', motivo: 'La wallet no compartió los datos necesarios para identificarte.' }
  }
  const foto = typeof d.picture === 'string' && FOTO.test(d.picture) ? d.picture : null

  if (solicitud.proposito === 'identificacion') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.birthdate ?? '')) return { estado: 'rechazada', motivo: 'La wallet no compartió la fecha de nacimiento, que la aerolínea necesita para clasificar al pasajero.' }
    const s = sesiones.get(solicitud.sesion)
    if (s) {
      s.persona = {
        documento: String(d.personal_administrative_number), nombres: d.given_name, apellidos: d.family_name,
        fecha_nacimiento: d.birthdate, foto, emisor_pid: pid.emisor,
      }
    }
    console.log('[identificación] pasajero verificado')
    return { estado: 'listo' }
  }

  // Embarque: el tiquete tiene que ser de esta aerolínea, estar vigente (lo comprueba el verifier con la status list),
  // y ser de quien lo presenta.
  const t = r.credenciales.tiquete
  if (!t || t.vct !== VCT_TIQUETE) return { estado: 'rechazada', motivo: 'Falta el tiquete.' }
  const q = t.datos
  const hoy = new Date().toISOString().slice(0, 10)
  const criterios = [
    { nombre: 'Tiquete emitido por esta aerolínea', cumple: t.emisor === URL_PUBLICA, detalle: t.emisor === URL_PUBLICA ? 'Firmado por la aerolínea y vigente (no cancelado).' : `Lo emitió otra entidad (${t.emisor}).` },
    { nombre: 'El tiquete es de quien se identifica', cumple: String(q.pasajero_documento) === String(d.personal_administrative_number), detalle: `Documento del tiquete ${q.pasajero_documento}; documento presentado ${d.personal_administrative_number}.` },
    { nombre: 'El nombre coincide', cumple: normal(q.pasajero_nombre) === normal(`${d.given_name} ${d.family_name}`), detalle: `Tiquete: ${q.pasajero_nombre}. Documento: ${d.given_name} ${d.family_name}.` },
    { nombre: solicitud.demo ? 'Fecha del vuelo (modo demostración: no se exige)' : 'El vuelo es hoy', cumple: solicitud.demo || q.fecha_salida === hoy, detalle: q.fecha_salida === hoy ? 'El vuelo sale hoy.' : `El vuelo sale el ${q.fecha_salida}.` },
  ]
  return {
    estado: 'listo',
    embarque: {
      puede: criterios.every((c) => c.cumple),
      criterios,
      tiquete: { reserva: q.reserva, numero: q.numero_tiquete, vuelo: q.vuelo, origen: q.origen, destino: q.destino, fecha: q.fecha_salida, hora: q.hora_salida, tarifa: q.tarifa, categoria: q.categoria_pasajero },
      pasajero: { nombre: `${d.given_name} ${d.family_name}`, documento: String(d.personal_administrative_number), foto },
    },
  }
}

async function consultar(solicitud) {
  if (solicitud.final) return solicitud.final
  const r = await verifier.resultado(solicitud.transaccion)
  if (r.estado === 'esperando') {
    if (Date.now() - solicitud.creada > VENCE_SOLICITUD_MS) solicitud.final = { estado: 'rechazada', motivo: 'La solicitud venció. Inténtalo de nuevo.' }
    return solicitud.final ?? r
  }
  if (r.estado === 'error') {
    console.log(`[${solicitud.proposito}] rechazada por el verifier: ${r.motivo}`)
    solicitud.final = { estado: 'rechazada', motivo: `No se pudo verificar: ${r.motivo}.` }
  } else {
    solicitud.final = completar(solicitud, r)
  }
  return solicitud.final
}

// --- Compra --------------------------------------------------------------------------------
const HOY = () => new Date().toISOString().slice(0, 10)
const codigoReserva = () => Array.from(randomBytes(6), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')
const textoCiudad = (c) => `${CIUDADES[c].nombre} (${c})`

function cotizar(persona, { origen, destino, fecha, salida, tarifa }) {
  if (!CIUDADES[origen] || !CIUDADES[destino] || origen === destino) return 'Elige un origen y un destino distintos.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '') || fecha < HOY()) return 'La fecha del vuelo debe ser hoy o futura.'
  if ((new Date(fecha) - new Date(HOY())) / 86400000 > 330) return 'Los vuelos se venden con hasta 330 días de anticipación.'
  if (!TARIFAS[tarifa]) return 'Elige una tarifa.'
  const vuelo = buscar({ origen, destino, fecha, codigo: CODIGO }).find((v) => v.salida === salida)
  if (!vuelo) return 'Ese vuelo no existe.'
  const cat = categoria(persona.fecha_nacimiento, fecha)
  if (!cat) return 'La fecha de nacimiento del pasajero no es válida.'
  return { vuelo, cat, valores: precio(vuelo, tarifa, cat) }
}

// --- Rutas ------------------------------------------------------------------------------------
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)

// El emisor (metadata en /.well-known/…/aerolinea, token, nonce, credencial, estado).
app.use(emisor.router)

const r = express.Router()
r.use(express.json({ limit: '20kb' }))
const pagina = readFileSync(new URL('./publico/index.html', import.meta.url), 'utf8')
  .replaceAll('{{BASE}}', BASE).replaceAll('{{AEROLINEA}}', aerolinea.nombre).replaceAll('{{CODIGO}}', CODIGO)

r.get('/salud', (_req, res) => res.json({ estado: 'ok' }))
r.get('/', (req, res) => { sesion(req, res); res.type('html').send(pagina) })
r.use('/publico', express.static(new URL('./publico', import.meta.url).pathname, { index: false }))

r.get('/api/ofertas', (_req, res) => res.json({ ofertas: OFERTAS(CIUDADES) }))
r.get('/api/destinos', (_req, res) => res.json({ ciudades: Object.entries(CIUDADES).map(([codigo, c]) => ({ codigo, ...c })), hoy: HOY() }))

// Vuelos de un día. Con el pasajero ya identificado, los precios son los suyos (según su categoría); si no, de adulto.
r.get('/api/vuelos', (req, res) => {
  const { origen, destino, fecha } = req.query
  if (!CIUDADES[origen] || !CIUDADES[destino] || origen === destino) return res.status(400).json({ error: 'Elige un origen y un destino distintos.' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '') || fecha < HOY()) return res.status(400).json({ error: 'La fecha debe ser hoy o futura.' })
  const p = sesion(req, res).persona
  const cat = (p && categoria(p.fecha_nacimiento, fecha)) || { nombre: 'Adulto', factor: 1, edad: null }
  const vuelos = buscar({ origen, destino, fecha, codigo: CODIGO }).map((v) => ({
    ...v,
    tarifas: Object.fromEntries(Object.keys(TARIFAS).map((t) => [t, { ...precio(v, t, cat), nombre: TARIFAS[t].nombre, equipaje: TARIFAS[t].equipaje, cambios: TARIFAS[t].cambios }])),
  }))
  res.json({ vuelos, categoria: cat.nombre, internacional: INTERNACIONAL(origen, destino), identificado: Boolean(p) })
})

// Pedirle algo a la wallet a través del verifier: el PID para identificarse, o el tiquete y el PID en el embarque.
r.post('/api/solicitud', async (req, res) => {
  const { proposito, demo } = req.body ?? {}
  const s = sesion(req, res)
  if (!PEDIDOS[proposito]) return res.status(400).json({ error: 'proposito: identificacion o embarque' })
  try {
    const { transaccion, enlace } = await verifier.crearSolicitud({ credenciales: PEDIDOS[proposito](), nonce: randomBytes(16).toString('base64url') })
    const id = randomBytes(16).toString('base64url')
    solicitudes.set(id, { proposito, transaccion, sesion: s.id, creada: Date.now(), demo: proposito === 'embarque' && demo === true })
    res.json({ id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 340 }), vence_en: VENCE_SOLICITUD_MS / 1000 })
  } catch (e) {
    console.error(`[${proposito}] ${e.message}`)
    res.status(503).json({ error: 'El servicio de verificación no está disponible. Inténtalo en unos minutos.' })
  }
})

r.get('/api/solicitud/:id', async (req, res) => {
  const solicitud = solicitudes.get(req.params.id)
  if (!solicitud || solicitud.sesion !== sesion(req, res).id) return res.status(404).json({ estado: 'rechazada', motivo: 'Solicitud desconocida.' })
  try {
    res.json(await consultar(solicitud))
  } catch (e) {
    console.error(`[${solicitud.proposito}] ${e.message}`)
    res.json({ estado: 'esperando' })
  }
})

r.get('/api/yo', (req, res) => {
  const p = sesion(req, res).persona
  if (!p) return res.status(401).json({ error: 'no te has identificado' })
  res.json(p)
})
r.post('/api/salir', (req, res) => { delete sesion(req, res).persona; res.json({ ok: true }) })

const conPersona = (fn) => (req, res) => {
  const p = sesion(req, res).persona
  if (!p) return res.status(401).json({ error: 'Primero identifícate con tu wallet.' })
  return fn(req, res, p)
}

async function oferta(reserva) {
  const o = emisor.ofrecer(reserva)
  return { ...o, qr: await QRCode.toDataURL(o.enlace, { margin: 1, width: 320 }) }
}

r.post('/api/comprar', conPersona(async (req, res, persona) => {
  const { origen, destino, fecha, salida, tarifa, email, telefono } = req.body ?? {}
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email ?? '')) return res.status(400).json({ error: 'Escribe un correo válido: ahí te llegará la confirmación.' })
  if (!/^\+?\d{7,15}$/.test(String(telefono ?? '').replace(/[\s-]/g, ''))) return res.status(400).json({ error: 'Escribe un teléfono de contacto válido (7 a 15 dígitos).' })
  const c = cotizar(persona, { origen, destino, fecha, salida, tarifa })
  if (typeof c === 'string') return res.status(400).json({ error: c })
  const { foto, ...sinFoto } = persona
  const reserva = tramites.crear({
    tipo: 'tiquete', persona: sinFoto,
    datos: {
      reserva: codigoReserva(), vuelo: c.vuelo.vuelo, origen, destino, origen_texto: textoCiudad(origen), destino_texto: textoCiudad(destino),
      fecha, salida, llegada: c.vuelo.llegada, tarifa, tarifa_nombre: TARIFAS[tarifa].nombre, equipaje: TARIFAS[tarifa].equipaje,
      categoria: c.cat.nombre, valor_pagado: cop(c.valores.total), internacional: c.vuelo.internacional,
      contacto: { email: email.trim(), telefono: String(telefono).trim() },
    },
  })
  // El número de tiquete (13 dígitos, como los de una aerolínea) sale del consecutivo.
  reserva.datos.numero_tiquete = `957${String(reserva.indice_estado).padStart(10, '0')}`
  tramites.actualizar(reserva)
  console.log(`[compra] ${reserva.datos.vuelo} ${origen}-${destino} ${fecha} (${c.cat.nombre})`)
  res.status(201).json({ reserva: vistaReserva(reserva), valores: c.valores, oferta: await oferta(reserva) })
}))

function vistaReserva(t) {
  const d = t.datos
  return {
    numero: t.numero, reserva: d.reserva, numero_tiquete: d.numero_tiquete, estado: t.estado, fecha_compra: t.fecha,
    vuelo: d.vuelo, origen: d.origen_texto, destino: d.destino_texto, fecha: d.fecha, salida: d.salida, llegada: d.llegada,
    tarifa: d.tarifa_nombre, equipaje: d.equipaje, categoria: d.categoria, valor_pagado: d.valor_pagado, internacional: d.internacional,
    entregas: t.entregas ?? 0,
  }
}

r.get('/api/tiquetes', conPersona((_req, res, persona) => res.json(tramites.dePersona(persona.documento).map(vistaReserva))))

r.post('/api/tiquetes/:numero/oferta', conPersona(async (req, res, persona) => {
  const t = tramites.buscar(req.params.numero)
  if (!t || t.persona.documento !== persona.documento) return res.status(404).json({ error: 'No es un tiquete tuyo.' })
  if (t.estado === 'anulado') return res.status(409).json({ error: 'Este tiquete está cancelado.' })
  res.json({ oferta: await oferta(t) })
}))

r.post('/api/tiquetes/:numero/cancelar', conPersona((req, res, persona) => {
  const t = tramites.buscar(req.params.numero)
  if (!t || t.persona.documento !== persona.documento) return res.status(404).json({ error: 'No es un tiquete tuyo.' })
  const anulado = tramites.anular(t.numero, 'Cancelado por el pasajero')
  estado.invalidar()
  console.log('[cancelación] tiquete cancelado')
  res.json(vistaReserva(anulado))
}))

app.use(BASE || '/', r)
const PUERTO = Number(process.env.PUERTO ?? 80)
app.listen(PUERTO, () => console.log(`${aerolinea.nombre} escuchando en :${PUERTO}${BASE} (emisor ${URL_PUBLICA}, verifier ${process.env.VERIFIER_API})`))
