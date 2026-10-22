// Portal de control de acceso (portería de un edificio): comprueba quién llega con su PID y le muestra al guardia la
// FOTO, el NOMBRE y el DOCUMENTO para que los compare con la persona que tiene delante y decida el ingreso.
//
//   1. El guardia pulsa «Nuevo ingreso» y se muestra un QR (no hace falta cámara en el computador: el que escanea es el
//      teléfono de la persona que llega).
//   2. La persona lo escanea con su wallet y acepta compartir foto, nombres, apellidos y número de documento.
//   3. El portal muestra esos datos YA VERIFICADOS (firma de la Registraduría, emisor en la lista PID, estado y prueba de
//      posesión) y el guardia pulsa «Permitir» o «Denegar».
//
// La comparación con la cara la hace el guardia: la foto del PID es la que emitió la Registraduría.
//
// Privacidad: la foto y los datos viven en memoria hasta que el guardia decide (o vencen en unos minutos) y luego se
// borran. El registro de la jornada guarda solo hora, nombre, documento y decisión, sin foto, y desaparece a la hora o al
// reiniciar. Al log del servidor solo van «permitido» o «denegado».
//
// Variables de entorno (las pone compose.yml a partir de .env):
//   URL_PUBLICA      https://civica-desarrollo.avance.org.co/acceso (el servidor escucha bajo esa ruta)
//   VERIFIER_API     http://verifier-acceso/verifier-acceso (red interna)
//   NOMBRE_ENTIDAD   el nombre que se muestra
//   PUERTO           puerto interno (80: srv-nw-nginx llama a app-acceso:80)

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import QRCode from 'qrcode'
import { crearVerifier } from './verifier.js'

const requerida = (n) => process.env[n] || (() => { throw new Error(`Falta la variable de entorno ${n}`) })()
const URL_PUBLICA = requerida('URL_PUBLICA').replace(/\/$/, '')
const BASE = new URL(URL_PUBLICA).pathname.replace(/\/$/, '')
const NOMBRE = process.env.NOMBRE_ENTIDAD ?? 'Edificio Cumbre'
const PUERTO = Number(process.env.PUERTO ?? 80)
const VENCE_SOLICITUD_MS = 5 * 60 * 1000
const CONSERVA_RESULTADO_MS = 10 * 60 * 1000
const CONSERVA_REGISTRO_MS = 60 * 60 * 1000
const MAX_REGISTRO = 50

const VCT_PID = 'urn:eudi:pid:1'
const DATOS_PID = ['picture', 'given_name', 'family_name', 'personal_administrative_number']
// La foto va como data URI; solo se acepta una imagen real (se pone en un <img>, nunca como HTML).
const FOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

const verifier = crearVerifier({ api: requerida('VERIFIER_API') })
const solicitudes = new Map() // id → { transaccion, creada, final?, decidida? }
const registro = []           // { hora, nombre, documento, decision } (más reciente primero)

setInterval(() => {
  const ahora = Date.now()
  for (const [id, s] of solicitudes) {
    if (ahora - (s.finalizada ?? s.creada) > CONSERVA_RESULTADO_MS) solicitudes.delete(id)
  }
  while (registro.length && ahora - registro[registro.length - 1].hora > CONSERVA_REGISTRO_MS) registro.pop()
}, 60 * 1000).unref()

function validar(r) {
  const pid = r.credenciales.pid
  if (!pid || pid.vct !== VCT_PID) return 'Falta el documento de identidad digital (PID).'
  const d = pid.datos
  for (const k of ['given_name', 'family_name', 'personal_administrative_number']) {
    if (!d[k]) return `La wallet no compartió un dato necesario (${k}).`
  }
  if (typeof d.picture !== 'string' || !FOTO.test(d.picture)) return 'La wallet no compartió la foto del documento de identidad.'
  return null
}

async function consultar(solicitud) {
  if (solicitud.final) return solicitud.final
  const r = await verifier.resultado(solicitud.transaccion)
  if (r.estado === 'esperando') {
    if (Date.now() - solicitud.creada > VENCE_SOLICITUD_MS) return fin(solicitud, { estado: 'rechazada', motivo: 'El código venció. Genera uno nuevo.' })
    return r
  }
  if (r.estado === 'error') return fin(solicitud, { estado: 'rechazada', motivo: `No se pudo verificar: ${r.motivo}.` })
  const motivo = validar(r)
  if (motivo) return fin(solicitud, { estado: 'rechazada', motivo })
  const pid = r.credenciales.pid
  const d = pid.datos
  return fin(solicitud, {
    estado: 'listo',
    persona: {
      nombres: d.given_name,
      apellidos: d.family_name,
      documento: String(d.personal_administrative_number),
      foto: d.picture,
      emisor: pid.emisor,
    },
  })
}

function fin(solicitud, final) {
  solicitud.final = final
  solicitud.finalizada = Date.now()
  return final
}

// --- Rutas ---------------------------------------------------------------------------------------
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '10kb' }))
const r = express.Router()
const pagina = readFileSync(new URL('./publico/index.html', import.meta.url), 'utf8')
  .replaceAll('{{BASE}}', BASE).replaceAll('{{NOMBRE}}', NOMBRE)

r.use('/publico', express.static(new URL('./publico', import.meta.url).pathname, { index: false }))
r.get('/salud', (_req, res) => res.json({ estado: 'ok' }))
r.get('/', (_req, res) => res.type('html').set('Cache-Control', 'no-store').send(pagina))

r.post('/api/solicitud', async (_req, res) => {
  try {
    const { transaccion, enlace } = await verifier.crearSolicitud({
      credenciales: [{ id: 'pid', vct: VCT_PID, datos: DATOS_PID }],
      nonce: randomBytes(16).toString('base64url'),
    })
    const id = randomBytes(16).toString('base64url')
    solicitudes.set(id, { transaccion, creada: Date.now() })
    res.json({ id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 360 }), vence_en: VENCE_SOLICITUD_MS / 1000 })
  } catch (e) {
    console.error(`[solicitud] ${e.message}`)
    res.status(503).json({ error: 'El servicio de verificación no está disponible. Inténtalo en unos minutos.' })
  }
})

r.get('/api/solicitud/:id', async (req, res) => {
  const solicitud = solicitudes.get(req.params.id)
  if (!solicitud) return res.status(404).json({ estado: 'rechazada', motivo: 'Solicitud desconocida.' })
  if (solicitud.decidida) return res.json({ estado: 'rechazada', motivo: 'Este ingreso ya se resolvió.' })
  try {
    res.json(await consultar(solicitud))
  } catch (e) {
    console.error(`[solicitud] ${e.message}`)
    res.json({ estado: 'esperando' })
  }
})

// El guardia decide. Se guarda en el registro de la jornada (sin foto) y se borran los datos de la solicitud.
r.post('/api/decision', (req, res) => {
  const { id, decision } = req.body ?? {}
  const solicitud = solicitudes.get(id)
  if (!['permitir', 'denegar'].includes(decision)) return res.status(400).json({ error: 'decision: permitir o denegar' })
  if (solicitud?.final?.estado !== 'listo' || solicitud.decidida) return res.status(409).json({ error: 'No hay un ingreso pendiente de decidir.' })
  const p = solicitud.final.persona
  const entrada = { hora: Date.now(), nombre: `${p.nombres} ${p.apellidos}`, documento: p.documento, decision: decision === 'permitir' ? 'permitido' : 'denegado' }
  registro.unshift(entrada)
  registro.length = Math.min(registro.length, MAX_REGISTRO)
  solicitud.decidida = true
  solicitud.final = { estado: 'rechazada', motivo: 'Este ingreso ya se resolvió.' } // fuera la foto de la memoria
  console.log(`[acceso] ${entrada.decision}`)
  res.json({ ok: true, entrada })
})

r.get('/api/registro', (_req, res) => res.set('Cache-Control', 'no-store').json({ registro }))

app.use(BASE || '/', r)
app.listen(PUERTO, () => console.log(`${NOMBRE}: control de acceso en :${PUERTO}${BASE} (verifier ${process.env.VERIFIER_API})`))
