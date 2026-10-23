// Universidad de ejemplo: carnet estudiantil, solo para estudiantes ACTIVOS, con la wallet.
//
//   1. Identificarse      la wallet presenta el PID a SU verifier (verifier-universidad):
//                         documento, nombres, apellidos y retrato.
//   2. Comprobar          se busca a la persona en el sistema académico: solo quien tiene un
//                         programa ACTIVO puede pedir carnet (uno por programa y periodo).
//   3. Recibirlo          la universidad emite el carnet como documento de la wallet
//                         (OpenID4VCI, ver emisor.js): QR + PIN. Una sola entrega.
//   4. Vigencia           vale hasta el fin del periodo y se revoca (status list) si el
//                         estudiante deja de figurar como activo (pausa, retiro, grado).
//   5. Verificar          cualquiera puede pedirle a una wallet el carnet y ver si es auténtico,
//                         está vigente y su titular sigue activo.
//
// Variables de entorno (las pone compose.yml a partir de .env):
//   URL_PUBLICA          p. ej. https://civica-desarrollo.avance.org.co/universidad (también es el credential_issuer)
//   VERIFIER_API         API de su verifier por la red interna: http://verifier-universidad/verifier-universidad
//   TRUST_VALIDATOR_URL  para comprobar las WIA de las wallets (abca.js)
//   UNIVERSIDAD_NOMBRE · FUNCIONARIO_NOMBRE
//   SECRETOS_DIR         ds.key y ds.crt (scripts/generar-claves.sh)
//   TRAMITES_ARCHIVO     el protocolo (JSON)
//   PUERTO               80 (el nginx central llama a <prefijo>:80)

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import { importPKCS8 } from 'jose'
import QRCode from 'qrcode'
import { crearAbca } from './abca.js'
import { crearAcademico } from './academico.js'
import { DOCUMENTOS, periodoActual, porVct } from './documentos.js'
import { crearEmisor } from './emisor.js'
import { crearEstado } from './estado.js'
import { crearTramites } from './tramites.js'
import { crearVerifier } from './verifier.js'

const requerida = (n) => process.env[n] || (() => { throw new Error(`Falta la variable de entorno ${n}`) })()
const URL_PUBLICA = requerida('URL_PUBLICA').replace(/\/$/, '')
const BASE = new URL(URL_PUBLICA).pathname.replace(/\/$/, '')
const SECRETOS = process.env.SECRETOS_DIR ?? '/secretos'
const universidad = { nombre: process.env.UNIVERSIDAD_NOMBRE ?? 'Universidad Industrial de Santander', funcionario: process.env.FUNCIONARIO_NOMBRE ?? 'Registro y Control Académico' }
const VENCE_SOLICITUD_MS = 5 * 60 * 1000
// Botón «Carnet Estudiantil» del issuer de la UIS: llega con un testigo firmado (HMAC-SHA256, secreto compartido).
const SECRETO_UIS = process.env.UIS_HANDOFF_SECRET ?? ''
const UIS_PUBLICA = (process.env.UIS_ISSUER_PUBLIC ?? '').replace(/\/$/, '')

// --- Piezas --------------------------------------------------------------------------------
const certificado = readFileSync(`${SECRETOS}/ds.crt`, 'utf8')
const firmante = {
  clave: await importPKCS8(readFileSync(`${SECRETOS}/ds.key`, 'utf8'), 'ES256'),
  x5c: [certificado.replace(/-----[^-]+-----|\s/g, '')],
}
const tramites = crearTramites(process.env.TRAMITES_ARCHIVO ?? '/datos/tramites.json')
const academico = crearAcademico({ url: requerida('ACADEMICO_URL') })

// Índices de la status list que valen 1: carnets anulados o reexpedidos y los de quien ya no figura como ACTIVO.
async function revocados() {
  const base = tramites.anulados()
  const vigentes = tramites.todos().filter((t) => t.estado === 'vigente')
  try {
    const estados = await academico.estados([...new Set(vigentes.map((t) => t.datos.historial))])
    return [...base, ...vigentes.filter((t) => estados.get(t.datos.historial) !== 'ACTIVO').map((t) => t.indice_estado)]
  } catch (e) {
    // Sin el sistema académico no se puede confirmar que sigan activos: se avisa y se sirve lo que consta en el protocolo.
    console.error(`[estado] no se pudo consultar el sistema académico: ${e.message}`)
    return base
  }
}
const estado = crearEstado({ firmante, uri: `${URL_PUBLICA}/estado/1`, anulados: revocados })
const abca = crearAbca({ trustValidator: requerida('TRUST_VALIDATOR_URL'), audiencia: URL_PUBLICA })
const emisor = crearEmisor({ url: URL_PUBLICA, universidad, firmante, tramites, estado, abca, trustValidator: process.env.TRUST_VALIDATOR_URL })
const verifier = crearVerifier({ api: requerida('VERIFIER_API') })

// --- Sesiones y solicitudes al verifier (en memoria: es un ejemplo) -------------------------
const sesiones = new Map()
const solicitudes = new Map() // id → { proposito: 'identificacion' | 'verificacion', tipo?, transaccion, sesion, creada, final? }

function sesion(req, res) {
  const id = /(?:^|;\s*)universidad_sesion=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1]
  if (id && sesiones.has(id)) return sesiones.get(id)
  const nueva = randomBytes(24).toString('base64url')
  sesiones.set(nueva, { id: nueva })
  res.append('Set-Cookie', `universidad_sesion=${nueva}; Path=${BASE || '/'}; HttpOnly; Secure; SameSite=Lax`)
  return sesiones.get(nueva)
}
setInterval(() => {
  const limite = Date.now() - 30 * 60 * 1000
  for (const [id, s] of solicitudes) if (s.creada < limite) solicitudes.delete(id)
}, 60 * 1000).unref()

// El carnet lleva nombre, documento y retrato: se piden del PID (nadie los escribe).
const DATOS_PID = ['personal_administrative_number', 'given_name', 'family_name', 'picture']

async function completar(solicitud, r) {
  if (solicitud.proposito === 'verificacion') {
    const tipo = porVct(r.vct)
    return {
      estado: 'listo',
      documento: {
        tipo, nombre: DOCUMENTOS[tipo]?.nombre ?? r.vct, emisor: r.emisor, de_esta_universidad: r.emisor === URL_PUBLICA,
        emitido: r.emitido && new Date(r.emitido * 1000).toISOString(), vence: r.vence && new Date(r.vence * 1000).toISOString(),
        datos: Object.fromEntries((DOCUMENTOS[tipo]?.datos ?? []).filter(([k]) => k in r.datos).map(([k, n]) => [n, r.datos[k]])),
        sha256: r.datos.documento_sha256 ?? null,
      },
    }
  }
  // Identificación: los datos salen del PID verificado; nadie los escribe.
  const d = r.datos
  if (!d.personal_administrative_number || !d.given_name || !d.family_name) {
    return { estado: 'rechazada', motivo: 'La wallet no compartió los datos necesarios para identificarte.' }
  }
  if (typeof d.picture !== 'string' || !d.picture.startsWith('data:image/')) {
    return { estado: 'rechazada', motivo: 'El carnet lleva tu retrato: comparte el retrato de tu documento de identidad.' }
  }
  const documento = String(d.personal_administrative_number)
  const pendiente = sesiones.get(solicitud.sesion)?.pendiente
  const soloDigitos = (v) => String(v).replace(/\D/g, '')
  if (pendiente && soloDigitos(pendiente.documento) !== soloDigitos(documento)) {
    const cola = (v) => `…${soloDigitos(v).slice(-3)}`
    console.log(`[identificación] el PID (${cola(documento)}) no es el estudiante de la UIS (${cola(pendiente.documento)})`)
    return { estado: 'rechazada', motivo: `Tu documento de identidad digital (${cola(documento)}) no corresponde al estudiante que pidió el carnet en la UIS (${cola(pendiente.documento)}).` }
  }
  let activos
  try { activos = await academico.activosDe(documento) } catch (e) {
    console.error(`[identificación] sistema académico: ${e.message}`)
    return { estado: 'rechazada', motivo: 'No se pudo consultar el sistema académico. Inténtalo en unos minutos.' }
  }
  if (!activos.length) {
    return { estado: 'rechazada', motivo: 'No figuras como estudiante activo. El carnet es solo para estudiantes con matrícula activa.' }
  }
  if (!activos.every((e) => academico.mismoNombre(e, d.given_name, d.family_name))) {
    return { estado: 'rechazada', motivo: 'El nombre de tu documento de identidad no coincide con el del registro académico.' }
  }
  const s = sesiones.get(solicitud.sesion)
  if (s) {
    s.persona = { documento, nombres: d.given_name, apellidos: d.family_name, foto: d.picture, emisor_pid: r.emisor }
  }
  console.log(`[identificación] ${d.personal_administrative_number} (${d.given_name} ${d.family_name}), PID de ${r.emisor}`)
  return { estado: 'listo' }
}

async function consultar(solicitud, responseCode) {
  if (solicitud.final) return solicitud.final
  const r = await verifier.resultado(solicitud.transaccion, responseCode)
  if (r.estado === 'esperando') {
    if (Date.now() - solicitud.creada > VENCE_SOLICITUD_MS) solicitud.final = { estado: 'rechazada', motivo: 'La solicitud venció. Inténtalo de nuevo.' }
    return solicitud.final ?? r
  }
  if (r.estado === 'error') {
    console.log(`[${solicitud.proposito}] rechazada por el verifier: ${r.motivo}${r.detalle ? ` (${JSON.stringify(r.detalle)})` : ''}`)
    solicitud.final = { estado: 'rechazada', motivo: `No se pudo verificar: ${r.motivo}.` }
  } else {
    solicitud.final = await completar(solicitud, r)
  }
  return solicitud.final
}

// --- Testigo del issuer de la UIS ------------------------------------------------------------
function leerTestigo(t) {
  if (!SECRETO_UIS) return null
  const [payload, firma] = String(t ?? '').split('.')
  if (!payload || !firma) return null
  const esperada = createHmac('sha256', SECRETO_UIS).update(payload).digest()
  const recibida = Buffer.from(firma, 'base64url')
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return d.e > Date.now() / 1000 ? d : null
  } catch { return null }
}

// --- Validación de la solicitud ---------------------------------------------------------------
// Código estudiantil: año de ingreso y número del historial.
const codigoEstudiantil = (e) => `${e.ingreso?.slice(0, 4) ?? 'EST'}${String(e.historial).padStart(5, '0')}`
async function validar(tipo, d = {}, persona) {
  if (tipo !== 'carnet') return 'Trámite desconocido.'
  if (!Number.isInteger(d.historial)) return 'Elige el programa del que quieres el carnet.'
  if (d.confirmo !== true) return 'Confirma que quieres el carnet.'
  // Se consulta de nuevo: debe seguir ACTIVO ahora, no solo cuando se identificó.
  const activos = await academico.activosDe(persona.documento)
  const e = activos.find((x) => x.historial === d.historial)
  if (!e) return 'Ese programa no figura como activo para ti.'
  const { periodo, vence } = periodoActual()
  return {
    historial: e.historial, codigo_estudiantil: codigoEstudiantil(e), programa: e.programa, nivel: e.nivel, facultad: e.facultad ?? '—',
    semestre: e.semestres + 1, periodo, fecha_vencimiento: vence,
  }
}

async function oferta(tramite) {
  const o = emisor.ofrecer(tramite)
  return { ...o, qr: await QRCode.toDataURL(o.enlace, { margin: 1, width: 320 }) }
}

// --- Rutas ------------------------------------------------------------------------------------
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)

// El emisor (metadata en /.well-known/…/universidad, token, nonce, credencial, estado).
app.use(emisor.router)

const r = express.Router()
r.use(express.json({ limit: '50kb' }))
const pagina = readFileSync(new URL('./publico/index.html', import.meta.url), 'utf8')
  .replaceAll('{{BASE}}', BASE).replaceAll('{{UNIVERSIDAD}}', universidad.nombre).replaceAll('{{FUNCIONARIO}}', universidad.funcionario)

const aviso = (texto) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Carnet Estudiantil</title><body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 20px"><h2 style="color:#14452b">Carnet Estudiantil</h2><p>${texto}</p><p><a href="${UIS_PUBLICA}/issuer/credentialsOffer/generate">Volver a la UIS</a></p></body>`
// El estudiante llega desde el botón «Carnet Estudiantil» de su programa en el issuer de la UIS.
r.get('/desde-uis', async (req, res) => {
  const s = sesion(req, res)
  const t = leerTestigo(req.query.t)
  if (!t) return res.status(400).type('html').send(aviso('El enlace no es válido o venció. Vuelve a la página de tus programas y pulsa de nuevo el botón.'))
  let e
  try { e = (await academico.activosDe(String(t.d))).find((x) => x.historial === t.h) } catch {
    return res.status(503).type('html').send(aviso('No se pudo consultar el sistema académico. Inténtalo en unos minutos.'))
  }
  if (!e) return res.status(409).type('html').send(aviso('Ese programa ya no figura como activo: el carnet es solo para estudiantes activos.'))
  delete s.persona // se identifica de nuevo con el PID: el retrato del carnet sale de ahí
  s.pendiente = { documento: String(t.d), historial: t.h, volver: typeof t.b === 'string' && UIS_PUBLICA && t.b.startsWith(`${UIS_PUBLICA}/`) ? t.b : null }
  res.redirect(`${BASE}/#carnet`)
})
r.get('/api/pendiente', async (req, res) => {
  const p = sesion(req, res).pendiente
  if (!p) return res.status(404).json({ error: 'No hay un carnet pendiente.' })
  const e = (await academico.activosDe(p.documento).catch(() => [])).find((x) => x.historial === p.historial)
  if (!e) return res.status(409).json({ error: 'Ese programa ya no figura como activo.' })
  res.json({ historial: p.historial, volver: p.volver, programa: e.programa, nivel: e.nivel, facultad: e.facultad, semestre: e.semestres + 1 })
})

r.get('/salud', (_req, res) => res.json({ estado: 'ok' }))
r.get('/', (req, res) => { sesion(req, res); res.type('html').send(pagina) })
r.use('/publico', express.static(new URL('./publico', import.meta.url).pathname, { index: false }))

// Pedirle algo a la wallet a través del verifier: el PID para identificarse, o un
// documento universidadl para comprobarlo.
r.post('/api/solicitud', async (req, res) => {
  const { proposito, tipo, dispositivo } = req.body ?? {}
  const s = sesion(req, res)
  let pedido
  if (proposito === 'identificacion') pedido = { vct: 'urn:eudi:pid:1', datos: DATOS_PID }
  else if (proposito === 'verificacion' && DOCUMENTOS[tipo]) pedido = { vct: DOCUMENTOS[tipo].vct, datos: DOCUMENTOS[tipo].datos.map(([k]) => k) }
  else return res.status(400).json({ error: 'proposito: identificacion, o verificacion con un tipo de documento' })
  try {
    const { transaccion, enlace } = await verifier.crearSolicitud({
      ...pedido,
      nonce: randomBytes(16).toString('base64url'),
      redireccion: dispositivo === 'mismo' ? `${URL_PUBLICA}/volver` : undefined,
    })
    const id = randomBytes(16).toString('base64url')
    solicitudes.set(id, { proposito, tipo, transaccion, sesion: s.id, creada: Date.now() })
    s.pendiente = id
    res.json({ id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 320 }) })
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

// A donde vuelve la wallet en el mismo teléfono.
r.get('/volver', async (req, res) => {
  const s = sesion(req, res)
  const solicitud = solicitudes.get(s.pendiente)
  const ir = (q) => res.redirect(`${BASE}/#${q}`)
  if (!solicitud || !req.query.response_code) return ir(`error=${encodeURIComponent('No encontramos la solicitud. Inténtalo de nuevo desde este navegador.')}`)
  try {
    const final = await consultar(solicitud, String(req.query.response_code))
    if (final.estado !== 'listo') return ir(`error=${encodeURIComponent(final.motivo ?? 'La wallet todavía no ha respondido.')}`)
    return ir(solicitud.proposito === 'verificacion' ? `verificado=${s.pendiente}` : 'identificado')
  } catch (e) {
    console.error(`[volver] ${e.message}`)
    return ir(`error=${encodeURIComponent('El servicio de verificación no está disponible.')}`)
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

r.post('/api/tramites', conPersona(async (req, res, persona) => {
  const { tipo, datos } = req.body ?? {}
  if (!DOCUMENTOS[tipo]) return res.status(400).json({ error: 'Trámite desconocido.' })
  let limpio
  try { limpio = await validar(tipo, datos, persona) } catch (e) {
    console.error(`[solicitud] sistema académico: ${e.message}`)
    return res.status(503).json({ error: 'No se pudo consultar el sistema académico. Inténtalo en unos minutos.' })
  }
  if (typeof limpio === 'string') return res.status(400).json({ error: limpio })
  const vigente = tramites.dePersona(persona.documento).find((t) => t.estado === 'vigente' && t.datos.historial === limpio.historial && t.datos.periodo === limpio.periodo)
  if (vigente) return res.status(409).json({ error: `Ya tienes el carnet de este programa para el periodo ${limpio.periodo}. Si lo perdiste, pide la reexpedición o repórtalo como perdido.` })
  // El retrato queda en el protocolo: es el que va en el carnet y hay que reexpedirlo si se pierde.
  const tramite = tramites.crear({ tipo, persona, datos: limpio })
  console.log(`[solicitud] ${DOCUMENTOS[tipo].nombre} ${tramite.numero} (${limpio.codigo_estudiantil})`)
  res.status(201).json({ tramite, oferta: await oferta(tramite) })
}))

r.get('/api/tramites', conPersona((_req, res, persona) => res.json(tramites.dePersona(persona.documento).map(({ persona: p, ...t }) => ({ ...t, persona: { documento: p.documento } })))))
// Estado académico actual del programa de cada carnet (para mostrar «ya no activo»).
r.get('/api/mis-estados', conPersona(async (_req, res, persona) => {
  const propios = tramites.dePersona(persona.documento)
  const estados = await academico.estados([...new Set(propios.map((t) => t.datos.historial))]).catch(() => new Map())
  res.json(Object.fromEntries(propios.map((t) => [t.numero, estados.get(t.datos.historial) ?? null])))
}))
// Los programas activos de quien se identificó (para elegir el carnet).
r.get('/api/programas', conPersona(async (_req, res, persona) => {
  try { res.json(await academico.activosDe(persona.documento)) } catch { res.status(503).json({ error: 'No se pudo consultar el sistema académico.' }) }
}))

r.post('/api/tramites/:numero/oferta', conPersona(async (req, res, persona) => {
  let tr = tramites.buscar(req.params.numero)
  if (!tr || tr.persona.documento !== persona.documento) return res.status(404).json({ error: 'No es un trámite tuyo.' })
  if (tr.estado === 'anulado') return res.status(409).json({ error: 'Este trámite está anulado.' })
  if ((tr.entregas ?? 0) > 0) {
    // Ya está en una wallet: no se entrega otra copia (acabarías con documentos repetidos). Si se perdió, se reexpide y la anterior queda revocada.
    if (req.body?.reexpedir !== true) return res.status(409).json({ error: 'Este documento ya está en una wallet. Si la perdiste, pide la reexpedición: la copia anterior dejará de valer.', ya_entregado: true })
    tr = tramites.reexpedir(tr.numero)
    estado.invalidar()
    console.log(`[reexpedición] ${DOCUMENTOS[tr.tipo].nombre} ${tr.numero}: la copia anterior queda revocada`)
  }
  res.json({ oferta: await oferta(tr) })
}))

r.post('/api/tramites/:numero/anular', conPersona((req, res, persona) => {
  const t = tramites.buscar(req.params.numero)
  if (!t || t.persona.documento !== persona.documento) return res.status(404).json({ error: 'No es un trámite tuyo.' })
  const anulado = tramites.anular(t.numero, String(req.body?.motivo ?? '').slice(0, 300) || 'Reportado como perdido por su titular')
  estado.invalidar()
  console.log(`[anulación] ${anulado.numero} de ${persona.documento}`)
  res.json(anulado)
}))

app.use(BASE || '/', r)
const PUERTO = Number(process.env.PUERTO ?? 80)
app.listen(PUERTO, () => console.log(`${universidad.nombre} escuchando en :${PUERTO}${BASE} (emisor ${URL_PUBLICA}, verifier ${process.env.VERIFIER_API})`))
