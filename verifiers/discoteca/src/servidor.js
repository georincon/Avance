// Discoteca de ejemplo: control de edad en la puerta con la wallet.
//
// El personal tiene esta página abierta en una tablet o un teléfono. Muestra un
// QR; la persona lo escanea con su wallet, que le dice qué se pide (solo «mayor
// de 18») y para qué, y al aceptar la pantalla se pone en verde o en rojo. Luego
// vuelve sola a un QR nuevo.
//
// Privacidad, que es el punto:
//   - a la wallet solo se le pide age_equal_or_over.<EDAD>: no llega nombre,
//     documento, foto ni fecha de nacimiento;
//   - aquí no se guarda nada: ni en disco ni en el log. Solo dos contadores en
//     memoria (entradas y rechazos de la noche), sin nada de las personas;
//   - su verifier tampoco lo conserva: su instancia guarda cada presentación
//     5 minutos (CONSERVAR_PRESENTACIONES=PT5M en ../_comun/instancias/discoteca/.env).
//
// Variables de entorno (las pone compose.yml):
//   URL_PUBLICA    https://civica-desarrollo.avance.org.co/discoteca (escucha bajo esa ruta)
//   VERIFIER_API   http://verifier-discoteca/verifier-discoteca (red interna)
//   NOMBRE         el nombre del local
//   EDAD_MINIMA    18
//   PUERTO         80

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import QRCode from 'qrcode'
import { crearVerifier } from './verifier.js'

const requerida = (n) => process.env[n] || (() => { throw new Error(`Falta la variable de entorno ${n}`) })()
const URL_PUBLICA = requerida('URL_PUBLICA').replace(/\/$/, '')
const BASE = new URL(URL_PUBLICA).pathname.replace(/\/$/, '')
const NOMBRE = process.env.NOMBRE ?? 'Discoteca'
const EDAD = Number(process.env.EDAD_MINIMA ?? 18)
const VENCE_MS = 5 * 60 * 1000

const verifier = crearVerifier({ api: requerida('VERIFIER_API'), edad: EDAD })
const solicitudes = new Map() // id → { transaccion, creada, final? }  (nada de la persona)
const noche = { entradas: 0, rechazos: 0, desde: new Date().toISOString() }

setInterval(() => {
  const limite = Date.now() - VENCE_MS
  for (const [id, s] of solicitudes) if (s.creada < limite) solicitudes.delete(id)
}, 30 * 1000).unref()

const app = express()
app.disable('x-powered-by')
const r = express.Router()
const pagina = readFileSync(new URL('./publico/index.html', import.meta.url), 'utf8')
  .replaceAll('{{BASE}}', BASE).replaceAll('{{NOMBRE}}', NOMBRE).replaceAll('{{EDAD}}', String(EDAD))

r.get('/salud', (_req, res) => res.json({ estado: 'ok' }))
r.get('/', (_req, res) => res.type('html').set('Cache-Control', 'no-store').send(pagina))

r.post('/api/solicitud', async (_req, res) => {
  try {
    const { transaccion, enlace } = await verifier.crearSolicitud(randomBytes(16).toString('base64url'))
    const id = randomBytes(16).toString('base64url')
    solicitudes.set(id, { transaccion, creada: Date.now() })
    res.json({ id, enlace, qr: await QRCode.toDataURL(enlace, { margin: 1, width: 480 }) })
  } catch (e) {
    console.error(`[puerta] ${e.message}`)
    res.status(503).json({ error: 'El verificador no responde.' })
  }
})

r.get('/api/solicitud/:id', async (req, res) => {
  const s = solicitudes.get(req.params.id)
  if (!s) return res.status(404).json({ estado: 'error', motivo: 'Solicitud desconocida.' })
  if (s.final) return res.json(s.final)
  try {
    const resultado = await verifier.resultado(s.transaccion)
    if (resultado.estado === 'esperando') {
      return res.json(Date.now() - s.creada > VENCE_MS ? { estado: 'vencida' } : { estado: 'esperando' })
    }
    if (resultado.estado === 'listo' && resultado.mayor === true) {
      s.final = { estado: 'entra' }
      noche.entradas++
    } else if (resultado.estado === 'listo' && resultado.mayor === false) {
      s.final = { estado: 'menor' }
      noche.rechazos++
    } else {
      s.final = { estado: 'error', motivo: resultado.motivo ?? 'El documento no trae la edad. Pide el PID de nuevo en tu wallet.' }
    }
    // Solo el resultado, nunca datos: es lo único que sale de aquí y del log.
    console.log(`[puerta] ${s.final.estado}`)
    res.json(s.final)
  } catch (e) {
    console.error(`[puerta] ${e.message}`)
    res.json({ estado: 'esperando' })
  }
})

r.get('/api/noche', (_req, res) => res.json(noche))

app.use(BASE || '/', r)
app.listen(Number(process.env.PUERTO ?? 80), () => console.log(`${NOMBRE}: control de edad (+${EDAD}) en ${BASE}`))
