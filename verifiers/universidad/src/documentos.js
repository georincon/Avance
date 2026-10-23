// El documento que emite la universidad: el carnet estudiantil. Solo para estudiantes ACTIVOS.
//
// Es una credencial SD-JWT VC (`vct` urn:co:universidad:carnet-estudiantil:1). Vale hasta el fin del
// periodo académico y deja de valer (status list) si el estudiante deja de figurar como activo.
// Quien lo recibe puede pedir solo algunos datos: cada uno se divulga por separado.
//
// Nombre, documento y retrato salen del PID presentado; programa, nivel y semestre, del sistema académico.

const DATOS_UNIVERSIDAD = [
  ['numero', 'Solicitud'],
  ['fecha', 'Fecha de emisión'],
  ['universidad', 'Institución'],
]

export const DOCUMENTOS = {
  carnet: {
    fondo: 'universidad-carnet.jpg',
    configuracion: 'co.universidad.carnet_estudiantil',
    vct: 'urn:co:universidad:carnet-estudiantil:1',
    nombre: 'Carnet estudiantil',
    descripcion: 'Carnet de estudiante activo de la universidad. Vale hasta el fin del periodo académico',
    color: '#1b5e3a',
    datos: [
      ...DATOS_UNIVERSIDAD,
      ['codigo_estudiantil', 'Código estudiantil'],
      ['nombres', 'Nombres'],
      ['apellidos', 'Apellidos'],
      ['documento', 'Documento de identidad'],
      ['retrato', 'Retrato'],
      ['programa', 'Programa'],
      ['nivel', 'Nivel'],
      ['facultad', 'Facultad'],
      ['semestre', 'Semestre'],
      ['periodo', 'Periodo'],
      ['estado_academico', 'Estado'],
      ['fecha_vencimiento', 'Válido hasta'],
    ],
  },
}

export const porConfiguracion = (id) => Object.values(DOCUMENTOS).find((d) => d.configuracion === id)
export const porVct = (vct) => Object.entries(DOCUMENTOS).find(([, d]) => d.vct === vct)?.[0]

/** Periodo académico vigente (simplificación del simulador): 1 hasta el 20 de junio, 2 hasta el 18 de diciembre. */
export function periodoActual(hoy = new Date()) {
  const y = hoy.getUTCFullYear()
  const p1 = `${y}-06-20`
  const iso = hoy.toISOString().slice(0, 10)
  if (iso <= p1) return { periodo: `${y}-1`, vence: p1 }
  const p2 = `${y}-12-18`
  if (iso <= p2) return { periodo: `${y}-2`, vence: p2 }
  return { periodo: `${y + 1}-1`, vence: `${y + 1}-06-20` }
}

/** Días de validez de la credencial: hasta el fin del periodo. */
export function validezDias(tramite) {
  const dias = Math.ceil((new Date(`${tramite.datos.fecha_vencimiento}T23:59:59Z`) - Date.now()) / 86400000)
  return Math.max(1, dias)
}

/** Los datos del documento de un trámite, en el orden de la definición. */
export function datosDelDocumento(tramite, universidad) {
  const p = tramite.persona
  const d = tramite.datos
  return {
    numero: tramite.numero, fecha: tramite.fecha.slice(0, 10), universidad: universidad.nombre,
    codigo_estudiantil: d.codigo_estudiantil, nombres: p.nombres, apellidos: p.apellidos, documento: p.documento, retrato: p.foto,
    programa: d.programa, nivel: d.nivel, facultad: d.facultad, semestre: d.semestre, periodo: d.periodo,
    estado_academico: 'ACTIVO', fecha_vencimiento: d.fecha_vencimiento,
  }
}
