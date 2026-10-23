// Portal de un empleador (Corporación Avance): verifica el NIVEL DE FORMACIÓN ACADÉMICA de una persona
// candidata con la credencial que le emitió la universidad, pidiendo solo lo necesario.
//
//   Un QR por nivel   El empleador elige el nivel que necesita comprobar (Doctorado, Maestría...). La wallet
//                     solo ofrece las credenciales de ESE nivel y de personas GRADUADAS (filtro por valor en la
//                     consulta). No se pide nombre ni documento: se pide programa, título y fecha de grado.
//   Identidad         Paso aparte y opcional ("Confirmar identidad"): nombres y documento, solo cuando el
//                     empleador los necesita. Es lo que recomienda el ARF: pre-evaluar sin identificar y pedir
//                     la identidad después, en otra presentación.
//
// La verificación (firma de la universidad, emisor de confianza, estado y prueba de posesión) la hace el verifier
// de su instancia (../_comun/levantar.sh contratacion); aquí solo se decide qué pedir y qué se acepta.
//
// Privacidad: no se guarda nada en disco ni en el log (solo «nivel, resultado»). Los resultados viven en memoria
// unos minutos para mostrarse y se borran.
//
// Contrato y firma (paso 3): con la formación y la identidad ya verificadas, el portal genera el contrato de
// trabajo en PDF y se lo ofrece a la persona para que lo firme desde su wallet ("Firmar → Escanear QR"). La
// wallet firma con su prestador de firma remota y devuelve el PDF firmado; el portal comprueba la firma y el
// sello de tiempo. Ver firma.js. Se activa si hay certificado de acceso (CLAVE_ACCESO / CADENA_ACCESO).
//
// Variables de entorno (las pone compose.yml a partir de .env):
//   URL_PUBLICA      https://civica-desarrollo.avance.org.co/contratacion (el servidor escucha bajo esa ruta)
//   VERIFIER_API     http://verifier-contratacion/verifier-contratacion (red interna)
//   NOMBRE_EMPLEADOR el nombre que se muestra
//   PUERTO           puerto interno (80: srv-nw-nginx llama a app-contratacion:80)
//   CLAVE_ACCESO, CADENA_ACCESO   clave y cadena del certificado de acceso del empleador (firman la solicitud)
//   RAIZ_CONFIANZA   raíz en la que se confía para comprobar las firmas recibidas

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import QRCode from 'qrcode'
import { crearVerifier } from './verifier.js'
import { cargarAcceso, crearContratoPdf, crearSolicitudJar, enlaceFirma, huella, nuevoId, sellarFirmado, verificarFirmado } from './firma.js'

const requerida = (n) => process.env[n] || (() => { throw new Error(`Falta la variable de entorno ${n}`) })()
const URL_PUBLICA = requerida('URL_PUBLICA').replace(/\/$/, '')
const BASE = new URL(URL_PUBLICA).pathname.replace(/\/$/, '')
const NOMBRE = process.env.NOMBRE_EMPLEADOR ?? 'Corporación Avance'
const PUERTO = Number(process.env.PUERTO ?? 80)
const VENCE_SOLICITUD_MS = 5 * 60 * 1000
const CONSERVA_RESULTADO_MS = 15 * 60 * 1000

const VCT = 'urn:eudi:academic:credential:1'
const ESTADO_EXIGIDO = 'GRADUADO'

// Los niveles que ofrece el portal. `clave` es el valor exacto que emite la universidad en `academic_level`.
const NIVELES = [
  { clave: 'DOCTORADO', nombre: 'Doctorado' },
  { clave: 'MAESTRIA', nombre: 'Maestría' },
  { clave: 'ESPECIALIZACION', nombre: 'Especialización' },
  { clave: 'PREGRADO', nombre: 'Pregrado' },
  { clave: 'TECNOLOGICO', nombre: 'Tecnología' },
  { clave: 'TECNICO', nombre: 'Técnico' },
  // Lo emitiría un colegio; todavía no hay un emisor de ese tipo en el ecosistema.
  { clave: 'BACHILLER', nombre: 'Bachiller', disponible: false, nota: 'Próximamente: aún no hay un emisor de colegios' },
]
const nivelDe = (clave) => NIVELES.find((n) => n.clave === clave && n.disponible !== false)

// Datos que se piden en cada paso, además de los dos filtros (nivel y estado) que van en los dos.
const PEDIDOS = {
  formacion: ['program_name', 'awarded_title', 'graduation_date'],
  identidad: ['given_name', 'family_name', 'identification_type', 'document_number'],
}

const VENCE_FIRMA_MS = 5 * 60 * 1000
let acceso = null
try {
  if (process.env.CLAVE_ACCESO && process.env.CADENA_ACCESO) {
    acceso = cargarAcceso({ clave: process.env.CLAVE_ACCESO, cadena: process.env.CADENA_ACCESO })
  }
} catch (e) {
  console.error(`Firma de contratos desactivada: ${e.message}`)
}
const RAIZ = process.env.RAIZ_CONFIANZA
// Autoridad de sellado de tiempo (RFC 3161). El SDK de la wallet firma sin sello; el portal se lo añade.
const TSA_URL = process.env.TSA_URL

async function pedirSello(consulta) {
  const r = await fetch(TSA_URL, { method: 'POST', headers: { 'content-type': 'application/timestamp-query' }, body: consulta, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`la autoridad de sellado respondió ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

const verifier = crearVerifier({ api: requerida('VERIFIER_API') })
const solicitudes = new Map() // id → { paso, nivel, transaccion, creada, final?, previa? }
const firmas = new Map() // id → { pdf, etiqueta, state, nonce, creada, estado, resultado?, firmado? }

setInterval(() => {
  const ahora = Date.now()
  for (const [id, s] of solicitudes) {
    if (ahora - (s.finalizada ?? s.creada) > CONSERVA_RESULTADO_MS) solicitudes.delete(id)
  }
  for (const [id, f] of firmas) {
    if (ahora - (f.terminada ?? f.creada) > CONSERVA_RESULTADO_MS) firmas.delete(id)
  }
}, 60 * 1000).unref()

// --- Qué se acepta -------------------------------------------------------------------------------
function validar(solicitud, { vct, datos, emisor }) {
  if (vct !== VCT) return 'La credencial presentada no es una credencial académica.'
  if (datos.academic_level !== solicitud.nivel) return 'La credencial no corresponde al nivel solicitado.'
  if (datos.academic_status !== ESTADO_EXIGIDO) return 'La persona no figura como graduada en ese nivel.'
  if (solicitud.paso === 'identidad') {
    for (const d of ['given_name', 'family_name', 'document_number']) {
      if (!datos[d]) return `La wallet no compartió un dato necesario (${d}).`
    }
  } else {
    for (const d of PEDIDOS.formacion) if (!datos[d]) return `La credencial no trae un dato necesario (${d}).`
  }
  return null
}

const formacion = ({ datos, emisor }) => ({
  nivel: datos.academic_level,
  programa: datos.program_name,
  titulo: datos.awarded_title,
  fecha_grado: datos.graduation_date,
  institucion: datos.issuing_institution_name ?? datos.issuing_authority ?? null,
  emisor,
})
const identidad = ({ datos }) => ({
  nombres: datos.given_name,
  apellidos: datos.family_name,
  tipo_documento: datos.identification_type ?? null,
  documento: datos.document_number,
})

async function consultar(solicitud) {
  if (solicitud.final) return solicitud.final
  const r = await verifier.resultado(solicitud.transaccion)
  if (r.estado === 'esperando') {
    if (Date.now() - solicitud.creada > VENCE_SOLICITUD_MS) {
      return fin(solicitud, { estado: 'rechazada', motivo: 'La solicitud venció. Genera un código nuevo.' })
    }
    return r
  }
  if (r.estado === 'error') {
    return fin(solicitud, { estado: 'rechazada', motivo: `No se pudo verificar: ${r.motivo}.` })
  }
  const motivo = validar(solicitud, r)
  if (motivo) return fin(solicitud, { estado: 'rechazada', motivo })
  const resultado = solicitud.paso === 'identidad'
    ? { estado: 'listo', formacion: solicitud.previa?.formacion ?? null, identidad: identidad(r) }
    : { estado: 'listo', formacion: formacion(r) }
  solicitud.resultado = resultado
  return fin(solicitud, resultado)
}

function fin(solicitud, final) {
  solicitud.final = final
  solicitud.finalizada = Date.now()
  // Solo el resultado, nunca datos de la persona: es lo único que sale de aquí y del log.
  console.log(`[${solicitud.paso}] ${solicitud.nivel}: ${final.estado === 'listo' ? 'verificada' : 'rechazada'}`)
  return final
}

// --- Rutas ---------------------------------------------------------------------------------------
const app = express()
app.disable('x-powered-by')
app.use(express.json())
const r = express.Router()
const pagina = readFileSync(new URL('./publico/index.html', import.meta.url), 'utf8')
  .replaceAll('{{BASE}}', BASE).replaceAll('{{NOMBRE}}', NOMBRE)

r.use('/publico', express.static(new URL('./publico', import.meta.url).pathname, { index: false }))
r.get('/salud', (_req, res) => res.json({ estado: 'ok' }))
r.get('/', (_req, res) => res.type('html').set('Cache-Control', 'no-store').send(pagina))
r.get('/api/niveles', (_req, res) => res.json({
  niveles: NIVELES.map(({ clave, nombre, disponible, nota }) => ({ clave, nombre, disponible: disponible !== false, nota })),
  pide: PEDIDOS,
  estado: ESTADO_EXIGIDO,
  firma: Boolean(acceso),
}))

// Crea la solicitud de un nivel (paso 'formacion') o la confirmación de identidad (paso 'identidad', que
// continúa una formación ya verificada).
r.post('/api/solicitud', async (req, res) => {
  const { nivel, paso = 'formacion', previa } = req.body ?? {}
  if (!PEDIDOS[paso]) return res.status(400).json({ error: 'paso: formacion o identidad' })
  if (!nivelDe(nivel)) return res.status(400).json({ error: 'nivel no disponible' })
  let anterior
  if (paso === 'identidad') {
    anterior = solicitudes.get(previa)
    if (anterior?.final?.estado !== 'listo' || anterior.nivel !== nivel) {
      return res.status(400).json({ error: 'primero hay que verificar la formación de ese nivel' })
    }
  }
  try {
    const { transaccion, enlace } = await verifier.crearSolicitud({
      vct: VCT,
      filtros: { academic_level: nivel, academic_status: ESTADO_EXIGIDO },
      datos: PEDIDOS[paso],
      nonce: randomBytes(16).toString('base64url'),
    })
    const id = randomBytes(16).toString('base64url')
    solicitudes.set(id, { paso, nivel, transaccion, creada: Date.now(), previa: anterior?.resultado ? { formacion: anterior.resultado.formacion } : undefined })
    res.json({ id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 360 }), vence_en: VENCE_SOLICITUD_MS / 1000 })
  } catch (e) {
    console.error(`[${paso}] ${e.message}`)
    res.status(503).json({ error: 'El servicio de verificación no está disponible. Inténtalo en unos minutos.' })
  }
})

r.get('/api/solicitud/:id', async (req, res) => {
  const solicitud = solicitudes.get(req.params.id)
  if (!solicitud) return res.status(404).json({ estado: 'rechazada', motivo: 'Solicitud desconocida.' })
  try {
    res.json(await consultar(solicitud))
  } catch (e) {
    console.error(`[${solicitud.paso}] ${e.message}`)
    res.json({ estado: 'esperando' })
  }
})

// --- Contrato y firma ----------------------------------------------------------------------------
const urlencoded = express.urlencoded({ extended: false, limit: '12mb' })

// Crea el contrato con lo verificado y la solicitud de firma. `previa` es una verificación de identidad lista.
r.post('/api/contrato', async (req, res) => {
  if (!acceso) return res.status(503).json({ error: 'La firma de contratos no está disponible en este portal.' })
  const { previa, cargo } = req.body ?? {}
  const anterior = solicitudes.get(previa)
  const resultado = anterior?.final
  if (resultado?.estado !== 'listo' || !resultado.identidad || !resultado.formacion) {
    return res.status(400).json({ error: 'Primero hay que verificar la formación y confirmar la identidad.' })
  }
  const puesto = String(cargo ?? '').trim()
  if (puesto.length < 3 || puesto.length > 80) return res.status(400).json({ error: 'Escribe el cargo (3 a 80 caracteres).' })

  const id = nuevoId()
  const i = resultado.identidad
  const pdf = crearContratoPdf({
    empleador: NOMBRE, nombres: i.nombres, apellidos: i.apellidos, tipoDocumento: i.tipo_documento, documento: i.documento,
    cargo: puesto, formacion: resultado.formacion,
    fecha: new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota' }),
  })
  const etiqueta = 'contrato-de-trabajo.pdf'
  const state = randomBytes(12).toString('base64url')
  const nonce = randomBytes(16).toString('base64url')
  firmas.set(id, { pdf, etiqueta, state, nonce, creada: Date.now(), estado: 'esperando', persona: `${i.nombres} ${i.apellidos}`, cargo: puesto })
  const enlace = enlaceFirma({ acceso, urlPublica: URL_PUBLICA, id })
  console.log('[contrato] solicitud de firma creada')
  res.json({
    id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 360 }), vence_en: VENCE_FIRMA_MS / 1000,
    documento: { etiqueta, bytes: pdf.length, sha256: huella(pdf), ver: `${BASE}/firma/documento/${id}.pdf` },
  })
})

// Lo que la wallet lee al escanear: la solicitud firmada y el documento.
r.get('/firma/solicitud/:id', (req, res) => {
  const f = firmas.get(req.params.id)
  if (!acceso || !f || f.estado !== 'esperando' || Date.now() - f.creada > VENCE_FIRMA_MS) return res.status(404).end()
  const jwt = crearSolicitudJar({ acceso, urlPublica: URL_PUBLICA, id: req.params.id, pdf: f.pdf, etiqueta: f.etiqueta, nonce: f.nonce, state: f.state })
  res.type('application/oauth-authz-req+jwt').set('Cache-Control', 'no-store').send(jwt)
})
r.get('/firma/documento/:id.pdf', (req, res) => {
  const f = firmas.get(req.params.id)
  if (!f) return res.status(404).end()
  res.type('application/pdf').set('Cache-Control', 'no-store').set('Content-Disposition', `inline; filename="${f.etiqueta}"`).send(f.pdf)
})

// La wallet devuelve aquí el PDF firmado (direct_post: documentWithSignature = lista JSON de PDFs en base64).
r.post('/firma/respuesta/:id', urlencoded, async (req, res) => {
  const f = firmas.get(req.params.id)
  if (!f || f.estado !== 'esperando') return res.status(404).json({ error: 'invalid_request' })
  if (req.body?.state !== f.state) return res.status(400).json({ error: 'invalid_request', error_description: 'state no coincide' })
  if (req.body?.error) {
    f.estado = 'rechazada'; f.terminada = Date.now(); f.motivo = req.body.error === 'user_cancelled' ? 'La persona canceló la firma.' : `La wallet respondió con un error (${req.body.error}).`
    console.log('[contrato] firma rechazada por la wallet')
    return res.json({})
  }
  let firmado
  try {
    const lista = JSON.parse(req.body.documentWithSignature ?? '[]')
    firmado = Buffer.from(String(lista[0] ?? ''), 'base64')
  } catch { return res.status(400).json({ error: 'invalid_request', error_description: 'documentWithSignature no es válido' }) }
  let verificacion = await verificarFirmado({ firmado, original: f.pdf, raiz: RAIZ })
  // Firma válida pero sin sello (lo normal: el SDK firma en nivel básico): se le añade el sello de tiempo y se
  // vuelve a comprobar TODO. Si el sello falla, se conserva la firma tal cual, sin sello.
  if (verificacion.valida && !verificacion.sello && TSA_URL) {
    try {
      const sellado = await sellarFirmado({ firmado, pedirSello })
      const nueva = await verificarFirmado({ firmado: sellado, original: f.pdf, raiz: RAIZ })
      if (nueva.valida && nueva.sello) {
        firmado = sellado
        verificacion = { ...nueva, selloAnadidoPorPortal: true }
      } else console.error('[contrato] el sello añadido no pasó la verificación; se conserva la firma sin sello')
    } catch (e) {
      console.error(`[contrato] no se pudo sellar: ${e.message}`)
    }
  }
  f.verificacion = verificacion
  f.terminada = Date.now()
  if (!verificacion.valida) {
    f.estado = 'invalida'
    console.log('[contrato] firma recibida pero NO válida')
    return res.status(400).json({ error: 'invalid_request', error_description: 'la firma no es válida' })
  }
  f.estado = 'firmado'
  f.firmado = firmado
  console.log(`[contrato] contrato firmado y verificado${verificacion.sello ? ' con sello de tiempo' : ' (sin sello)'}`)
  res.json({})
})

r.get('/api/firma/:id', (req, res) => {
  const f = firmas.get(req.params.id)
  if (!f) return res.status(404).json({ estado: 'rechazada', motivo: 'Solicitud desconocida.' })
  if (f.estado === 'esperando') {
    if (Date.now() - f.creada > VENCE_FIRMA_MS) return res.json({ estado: 'rechazada', motivo: 'La solicitud venció. Genera un código nuevo.' })
    return res.json({ estado: 'esperando' })
  }
  if (f.estado === 'rechazada') return res.json({ estado: 'rechazada', motivo: f.motivo })
  if (f.estado === 'invalida') return res.json({ estado: 'invalida', verificacion: f.verificacion })
  res.json({
    estado: 'firmado', persona: f.persona, cargo: f.cargo, verificacion: f.verificacion,
    descargar: `${BASE}/firma/firmado/${req.params.id}.pdf`, bytes: f.firmado.length,
  })
})
r.get('/firma/firmado/:id.pdf', (req, res) => {
  const f = firmas.get(req.params.id)
  if (f?.estado !== 'firmado') return res.status(404).end()
  res.type('application/pdf').set('Cache-Control', 'no-store').set('Content-Disposition', 'attachment; filename="contrato-de-trabajo-firmado.pdf"').send(f.firmado)
})

app.use(BASE || '/', r)
app.listen(PUERTO, () => console.log(`${NOMBRE}: verificación académica en :${PUERTO}${BASE} (verifier ${process.env.VERIFIER_API}; firma de contratos ${acceso ? 'activa' : 'desactivada'})`))
