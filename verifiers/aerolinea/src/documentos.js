// El documento que emite la aerolínea: el tiquete aéreo.
//
// Es una credencial SD-JWT VC con su `vct`. La wallet muestra el nombre, los colores y el nombre de cada dato tal
// como están aquí (salen en la metadata OpenID4VCI), y quien lo verifica (el embarque) puede pedir solo algunos datos:
// cada uno se divulga por separado.
//
// Los datos del pasajero (nombre, documento, fecha de nacimiento) no los escribe nadie: salen del PID que presentó al
// comprar, ya verificado por el verifier. Una aerolínea los necesita porque el tiquete es nominal e intransferible.

export const DOCUMENTOS = {
  tiquete: {
    // Fondo de la tarjeta en la wallet (scripts/generar-fondos.py).
    fondo: 'aerolinea-tiquete.jpg',
    configuracion: 'co.aerolinea.tiquete',
    vct: 'urn:co:aerolinea:tiquete:1',
    nombre: 'Tiquete aéreo',
    descripcion: 'Tiquete nominal e intransferible con su reserva y su vuelo',
    color: '#0b3d91',
    datos: [
      ['aerolinea', 'Aerolínea'],
      ['reserva', 'Código de reserva'],
      ['numero_tiquete', 'Número de tiquete'],
      ['pasajero_nombre', 'Pasajero'],
      ['pasajero_documento', 'Documento del pasajero'],
      ['categoria_pasajero', 'Tipo de pasajero'],
      ['vuelo', 'Vuelo'],
      ['origen', 'Origen'],
      ['destino', 'Destino'],
      ['fecha_salida', 'Fecha de salida'],
      ['hora_salida', 'Hora de salida'],
      ['hora_llegada', 'Hora de llegada'],
      ['tarifa', 'Tarifa'],
      ['equipaje', 'Equipaje incluido'],
      ['valor_pagado', 'Valor pagado'],
      ['fecha_emision', 'Fecha de emisión'],
    ],
  },
}

export const porConfiguracion = (id) => Object.values(DOCUMENTOS).find((d) => d.configuracion === id)
export const porVct = (vct) => Object.entries(DOCUMENTOS).find(([, d]) => d.vct === vct)?.[0]

/** Los datos del tiquete de una reserva, en el orden de la definición. */
export function datosDelDocumento(reserva, aerolinea) {
  const d = reserva.datos
  const p = reserva.persona
  return {
    aerolinea: aerolinea.nombre,
    reserva: d.reserva,
    numero_tiquete: d.numero_tiquete,
    pasajero_nombre: `${p.nombres} ${p.apellidos}`,
    pasajero_documento: p.documento,
    categoria_pasajero: d.categoria,
    vuelo: d.vuelo,
    origen: d.origen_texto,
    destino: d.destino_texto,
    fecha_salida: d.fecha,
    hora_salida: d.salida,
    hora_llegada: d.llegada,
    tarifa: d.tarifa_nombre,
    equipaje: d.equipaje,
    valor_pagado: d.valor_pagado,
    fecha_emision: reserva.fecha.slice(0, 10),
  }
}

/** Días de validez: hasta un día después del vuelo (mínimo 1). */
export function validezDias(reserva) {
  const dias = Math.ceil((new Date(`${reserva.datos.fecha}T23:59:59Z`) - Date.now()) / 86400000) + 1
  return Math.max(1, Math.min(dias, 365))
}
