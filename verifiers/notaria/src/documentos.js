// Los documentos que emite la notaría: uno por trámite.
//
// Cada uno es una credencial SD-JWT VC con su `vct`. La wallet muestra el nombre,
// los colores y el nombre de cada dato tal como están aquí (salen en la metadata
// OpenID4VCI), y quien lo recibe puede pedir solo algunos datos: cada uno se
// divulga por separado.
//
// Los datos de la persona (nombre y documento) no los escribe nadie: salen del
// PID que presentó al identificarse, ya verificado por el verifier.

const DATOS_NOTARIA = [
  ['numero', 'Número'],
  ['fecha', 'Fecha'],
  ['notaria', 'Notaría'],
  ['notario', 'Notario'],
]

export const DOCUMENTOS = {
  declaracion: {
    // Fondo de la tarjeta en la wallet (scripts/generar-fondos.py).
    fondo: 'notaria-declaracion.jpg',
    configuracion: 'co.notaria.declaracion_extraproceso',
    vct: 'urn:co:notaria:declaracion-extraproceso:1',
    nombre: 'Declaración extraproceso',
    descripcion: 'Declaración bajo juramento ante notario (Decreto 1557 de 1989)',
    color: '#374d95',
    datos: [
      ...DATOS_NOTARIA,
      ['declarante_nombre', 'Declarante'],
      ['declarante_documento', 'Documento del declarante'],
      ['finalidad', 'Con destino a'],
      ['declaracion', 'Declaración'],
    ],
  },
  poder: {
    // Fondo de la tarjeta en la wallet (scripts/generar-fondos.py).
    fondo: 'notaria-poder.jpg',
    configuracion: 'co.notaria.poder_especial',
    vct: 'urn:co:notaria:poder-especial:1',
    nombre: 'Poder especial',
    descripcion: 'Poder especial con presentación personal ante notario',
    color: '#1f5f9e',
    datos: [
      ...DATOS_NOTARIA,
      ['poderdante_nombre', 'Poderdante'],
      ['poderdante_documento', 'Documento del poderdante'],
      ['apoderado_nombre', 'Apoderado'],
      ['apoderado_documento', 'Documento del apoderado'],
      ['facultades', 'Facultades'],
      ['vigente_hasta', 'Vigente hasta'],
    ],
  },
  reconocimiento: {
    // Fondo de la tarjeta en la wallet (scripts/generar-fondos.py).
    fondo: 'notaria-reconocimiento.jpg',
    configuracion: 'co.notaria.reconocimiento_documento',
    vct: 'urn:co:notaria:reconocimiento-documento:1',
    nombre: 'Reconocimiento de documento',
    descripcion: 'Reconocimiento de firma y contenido de un documento privado',
    color: '#0146a0',
    datos: [
      ...DATOS_NOTARIA,
      ['firmante_nombre', 'Firmante'],
      ['firmante_documento', 'Documento del firmante'],
      ['documento_nombre', 'Documento'],
      ['documento_sha256', 'Huella SHA-256 del documento'],
      ['documento_bytes', 'Tamaño (bytes)'],
    ],
  },
  fe_vida: {
    fondo: 'notaria-fe-vida.jpg',
    configuracion: 'co.notaria.fe_de_vida',
    vct: 'urn:co:notaria:fe-de-vida:1',
    nombre: 'Fe de vida',
    descripcion: 'Constancia ante notario de que la persona vive (Decreto-Ley 960 de 1970, art. 78)',
    color: '#1a6f8f',
    validezDias: 30,
    datos: [
      ...DATOS_NOTARIA,
      ['titular_nombre', 'Titular'],
      ['titular_documento', 'Documento del titular'],
      ['medio_identificacion', 'Medio de identificación'],
      ['entidad_destino', 'Con destino a'],
      ['vigente_hasta', 'Válida hasta'],
    ],
  },
  autenticacion: {
    fondo: 'notaria-autenticacion.jpg',
    configuracion: 'co.notaria.autenticacion_firma',
    vct: 'urn:co:notaria:autenticacion-firma:1',
    nombre: 'Autenticación de firma',
    descripcion: 'Testimonio de que la firma de un documento es de quien lo firma (Decreto-Ley 960 de 1970, art. 73)',
    color: '#4a3f9e',
    datos: [
      ...DATOS_NOTARIA,
      ['firmante_nombre', 'Firmante'],
      ['firmante_documento', 'Documento del firmante'],
      ['documento_nombre', 'Documento'],
      ['documento_sha256', 'Huella SHA-256 del documento'],
      ['documento_bytes', 'Tamaño (bytes)'],
      ['alcance', 'Alcance'],
    ],
  },
  permiso_menor: {
    fondo: 'notaria-permiso-menor.jpg',
    configuracion: 'co.notaria.permiso_salida_menor',
    vct: 'urn:co:notaria:permiso-salida-menor:1',
    nombre: 'Permiso de salida de menor',
    descripcion: 'Autorización de un progenitor para que un menor viaje fuera del país',
    color: '#2d447c',
    // Dura hasta el regreso del viaje (ver `validezDias`).
    datos: [
      ...DATOS_NOTARIA,
      ['otorgante_nombre', 'Otorgante'],
      ['otorgante_documento', 'Documento del otorgante'],
      ['calidad', 'En calidad de'],
      ['menor_nombre', 'Menor'],
      ['menor_documento', 'Documento del menor'],
      ['destino', 'Destino'],
      ['fecha_salida', 'Fecha de salida'],
      ['fecha_regreso', 'Fecha de regreso'],
      ['acompanante', 'Viaja con'],
      ['otro_progenitor', 'Otro progenitor'],
    ],
  },
}

export const porConfiguracion = (id) => Object.values(DOCUMENTOS).find((d) => d.configuracion === id)
export const porVct = (vct) => Object.entries(DOCUMENTOS).find(([, d]) => d.vct === vct)?.[0]

/** Días de validez del documento: el de cada tipo, o hasta el regreso del viaje en el permiso de menor. */
export function validezDias(tramite) {
  if (tramite.tipo === 'permiso_menor') {
    const dias = Math.ceil((new Date(`${tramite.datos.fecha_regreso}T23:59:59Z`) - Date.now()) / 86400000)
    return Math.max(1, Math.min(dias, 365))
  }
  return DOCUMENTOS[tramite.tipo]?.validezDias
}

/** Los datos del documento de un trámite, en el orden de la definición. */
export function datosDelDocumento(tramite, notaria) {
  const p = tramite.persona
  const nombre = `${p.nombres} ${p.apellidos}`
  const base = { numero: tramite.numero, fecha: tramite.fecha.slice(0, 10), notaria: notaria.nombre, notario: notaria.notario }
  const d = tramite.datos
  switch (tramite.tipo) {
    case 'declaracion':
      return { ...base, declarante_nombre: nombre, declarante_documento: p.documento, finalidad: d.finalidad, declaracion: d.declaracion }
    case 'poder':
      return {
        ...base, poderdante_nombre: nombre, poderdante_documento: p.documento,
        apoderado_nombre: d.apoderado_nombre, apoderado_documento: d.apoderado_documento,
        facultades: d.facultades, vigente_hasta: d.vigente_hasta,
      }
    case 'reconocimiento':
      return {
        ...base, firmante_nombre: nombre, firmante_documento: p.documento,
        documento_nombre: d.documento_nombre, documento_sha256: d.documento_sha256, documento_bytes: d.documento_bytes,
      }
    case 'fe_vida': {
      const hasta = new Date(Date.now() + DOCUMENTOS.fe_vida.validezDias * 86400000).toISOString().slice(0, 10)
      return {
        ...base, titular_nombre: nombre, titular_documento: p.documento,
        medio_identificacion: `Documento de identidad digital (PID) presentado con la wallet${p.emisor_pid ? `, emitido por ${p.emisor_pid}` : ''}`,
        entidad_destino: d.entidad_destino || 'Quien lo requiera', vigente_hasta: hasta,
      }
    }
    case 'autenticacion':
      return {
        ...base, firmante_nombre: nombre, firmante_documento: p.documento,
        documento_nombre: d.documento_nombre, documento_sha256: d.documento_sha256, documento_bytes: d.documento_bytes,
        alcance: 'Testimonio de que la firma corresponde a quien firma. No equivale a reconocimiento ni da mayor fuerza al documento (Decreto-Ley 960 de 1970, art. 77).',
      }
    case 'permiso_menor':
      return {
        ...base, otorgante_nombre: nombre, otorgante_documento: p.documento, calidad: d.calidad,
        menor_nombre: d.menor_nombre, menor_documento: `${d.menor_tipo_documento} ${d.menor_documento}`,
        destino: d.destino, fecha_salida: d.fecha_salida, fecha_regreso: d.fecha_regreso,
        acompanante: d.acompanante || 'Viaja solo(a)', otro_progenitor: d.otro_progenitor,
      }
    default:
      throw new Error(`tipo de trámite desconocido: ${tramite.tipo}`)
  }
}
