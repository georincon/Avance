// Portal de un fondo de pensiones (ficticio): comprueba la SUPERVIVENCIA de un pensionado, que es lo que cada cierto tiempo exige un fondo
// para seguir pagando la mesada. Con la wallet se hace sin ir a una oficina:
//
//   Fe de vida (notaría)   constancia de que la persona vive, con su vigencia (30 días). La emite una notaría con su PID.
//   PID (Registraduría)    nombre y documento de quien se presenta.
//
// Las dos van en UNA presentación (dos credenciales de emisores distintos). El fondo comprueba que la fe de vida la emitió una notaría en la que
// confía, que no está vencida y que es de la misma persona que se identificó. No se guarda nada: el registro de la jornada vive en memoria y
// solo lleva iniciales y los últimos dígitos del documento.
//
// Variables de entorno (las pone compose.yml a partir de .env):
//   URL_PUBLICA      https://civica-desarrollo.avance.org.co/pensiones
//   VERIFIER_API     http://verifier-pensiones/verifier-pensiones (red interna)
//   NOMBRE_ENTIDAD   el nombre que se muestra
//   PUERTO           80

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import QRCode from 'qrcode'
import { crearVerifier } from './verifier.js'

const requerida = (n) => process.env[n] || (() => { throw new Error(`Falta la variable de entorno ${n}`) })()
const URL_PUBLICA = requerida('URL_PUBLICA').replace(/\/$/, '')
const BASE = new URL(URL_PUBLICA).pathname.replace(/\/$/, '')
const NOMBRE = process.env.NOMBRE_ENTIDAD ?? 'Fondo de Pensiones Horizonte'
const PUERTO = Number(process.env.PUERTO ?? 80)
const VENCE_SOLICITUD_MS = 5 * 60 * 1000
const CONSERVA_MS = 60 * 60 * 1000

const VCT_PID = 'urn:eudi:pid:1'
const VCT_FE_DE_VIDA = 'urn:co:notaria:fe-de-vida:1'
// La fe de vida solo vale si la emitió una notaría en la que el fondo confía: la del ecosistema (mismo dominio, prefijo /notaria).
const EMISOR_NOTARIA = `${new URL(URL_PUBLICA).origin}/notaria`

const verifier = crearVerifier({ api: requerida('VERIFIER_API') })
const solicitudes = new Map()  // id → { transaccion, creada, final? }
const acreditados = []         // { hora, pensionado, documento, vence } más reciente primero

const normal = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
const digitos = (t) => String(t ?? '').replace(/\D/g, '')
const iniciales = (n) => String(n).split(/\s+/).filter(Boolean).map((x) => `${x[0].toUpperCase()}.`).join(' ')

setInterval(() => {
  const ahora = Date.now()
  for (const [id, s] of solicitudes) if (ahora - (s.finalizada ?? s.creada) > 15 * 60 * 1000) solicitudes.delete(id)
  while (acreditados.length && ahora - acreditados[acreditados.length - 1].hora > CONSERVA_MS) acreditados.pop()
}, 60 * 1000).unref()

const PEDIDO = () => [
  { id: 'fe', vct: VCT_FE_DE_VIDA, datos: ['numero', 'fecha', 'titular_nombre', 'titular_documento', 'entidad_destino', 'vigente_hasta'] },
  { id: 'pid', vct: VCT_PID, datos: ['personal_administrative_number', 'given_name', 'family_name'] },
]

function evaluar({ fe, pid }) {
  const f = fe.datos
  const d = pid.datos
  const hoy = new Date().toISOString().slice(0, 10)
  const nombrePid = `${d.given_name} ${d.family_name}`
  const criterios = [
    { nombre: 'Fe de vida emitida por una notaría de confianza', cumple: fe.emisor === EMISOR_NOTARIA, detalle: fe.emisor === EMISOR_NOTARIA ? `Constancia n.º ${f.numero}, firmada por la notaría y vigente (no revocada).` : `La emitió otra entidad (${fe.emisor}).` },
    { nombre: 'Es de la persona que se identificó (documento)', cumple: digitos(f.titular_documento) !== '' && digitos(f.titular_documento) === digitos(d.personal_administrative_number), detalle: `Titular de la constancia: documento ${f.titular_documento}. Documento presentado: ${d.personal_administrative_number}.` },
    { nombre: 'El nombre coincide', cumple: normal(f.titular_nombre) === normal(nombrePid), detalle: `Constancia: ${f.titular_nombre}. Documento: ${nombrePid}.` },
    { nombre: 'La fe de vida está vigente', cumple: /^\d{4}-\d{2}-\d{2}$/.test(f.vigente_hasta ?? '') && f.vigente_hasta >= hoy, detalle: `Válida hasta el ${f.vigente_hasta}.` },
  ]
  return {
    acreditada: criterios.every((c) => c.cumple),
    criterios,
    datos: { pensionado: nombrePid, documento: String(d.personal_administrative_number), diligencia: f.fecha, vence: f.vigente_hasta, notaria_numero: f.numero, destino: f.entidad_destino ?? null },
  }
}

async function consultar(solicitud) {
  if (solicitud.final) return solicitud.final
  const r = await verifier.resultado(solicitud.transaccion)
  if (r.estado === 'esperando') {
    if (Date.now() - solicitud.creada > VENCE_SOLICITUD_MS) return fin(solicitud, { estado: 'rechazada', motivo: 'El código venció. Genera uno nuevo.' })
    return r
  }
  if (r.estado === 'error') return fin(solicitud, { estado: 'rechazada', motivo: `No se pudo verificar: ${r.motivo}.` })
  const { fe, pid } = r.credenciales
  if (!fe || fe.vct !== VCT_FE_DE_VIDA) return fin(solicitud, { estado: 'rechazada', motivo: 'Falta la fe de vida.' })
  if (!pid || pid.vct !== VCT_PID) return fin(solicitud, { estado: 'rechazada', motivo: 'Falta el documento de identidad digital (PID).' })
  const ev = evaluar(r.credenciales)
  if (ev.acreditada) {
    acreditados.unshift({ hora: Date.now(), pensionado: iniciales(ev.datos.pensionado), documento: `•••${digitos(ev.datos.documento).slice(-3)}`, vence: ev.datos.vence })
    acreditados.length = Math.min(acreditados.length, 50)
  }
  console.log(`[supervivencia] ${ev.acreditada ? 'acreditada' : 'no acreditada'}`)
  return fin(solicitud, { estado: 'listo', supervivencia: ev })
}
function fin(solicitud, final) { solicitud.final = final; solicitud.finalizada = Date.now(); return final }

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '10kb' }))
const r = express.Router()
const pagina = readFileSync(new URL('./publico/index.html', import.meta.url), 'utf8').replaceAll('{{BASE}}', BASE).replaceAll('{{NOMBRE}}', NOMBRE)
r.use('/publico', express.static(new URL('./publico', import.meta.url).pathname, { index: false }))
r.get('/salud', (_req, res) => res.json({ estado: 'ok' }))
r.get('/', (_req, res) => res.type('html').set('Cache-Control', 'no-store').send(pagina))

r.post('/api/solicitud', async (_req, res) => {
  try {
    const { transaccion, enlace } = await verifier.crearSolicitud({ credenciales: PEDIDO(), nonce: randomBytes(16).toString('base64url') })
    const id = randomBytes(16).toString('base64url')
    solicitudes.set(id, { transaccion, creada: Date.now() })
    res.json({ id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 340 }), vence_en: VENCE_SOLICITUD_MS / 1000 })
  } catch (e) {
    console.error(`[solicitud] ${e.message}`)
    res.status(503).json({ error: 'El servicio de verificación no está disponible. Inténtalo en unos minutos.' })
  }
})
r.get('/api/solicitud/:id', async (req, res) => {
  const s = solicitudes.get(req.params.id)
  if (!s) return res.status(404).json({ estado: 'rechazada', motivo: 'Solicitud desconocida.' })
  try { res.json(await consultar(s)) } catch (e) { console.error(`[solicitud] ${e.message}`); res.json({ estado: 'esperando' }) }
})
r.get('/api/acreditados', (_req, res) => res.set('Cache-Control', 'no-store').json({ acreditados }))

app.use(BASE || '/', r)
app.listen(PUERTO, () => console.log(`${NOMBRE}: prueba de supervivencia en :${PUERTO}${BASE} (verifier ${process.env.VERIFIER_API})`))
