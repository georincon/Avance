// El sistema académico de la UIS (solo lectura): de aquí sale quién es estudiante ACTIVO y en qué programa.
// Es la misma base que usa el issuer de credenciales académicas (eudi-srv-issuer-pid-uis).

import pg from 'pg'

const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().split(/\s+/).filter(Boolean)

export function crearAcademico({ url }) {
  const pool = new pg.Pool({ connectionString: url, max: 4 })

  return {
    /** Programas ACTIVOS del estudiante con ese documento (puede haber varios), o [] si no figura. */
    async activosDe(documento) {
      const { rows } = await pool.query(
        `SELECT h.id_historial, d.id_estudiante, d.nombres, d.apellidos, d.numero_identificacion,
                p.codigo, p.nombre AS programa, p.nivel_academico, p.facultad, p.modalidad,
                h.semestres_cursados, h.fecha_ingreso
           FROM historial_estudiantes h
           JOIN datos_estudiantes d ON d.id_estudiante = h.estudiante_id
           JOIN programas_academicos p ON p.id_programa = h.programa_id
          WHERE d.numero_identificacion = $1 AND h.estado_academico = 'ACTIVO' AND p.activo
          ORDER BY h.fecha_ingreso DESC NULLS LAST`, [String(documento)])
      return rows.map((r) => ({
        historial: Number(r.id_historial), estudiante: Number(r.id_estudiante), nombres: r.nombres, apellidos: r.apellidos,
        codigo_programa: r.codigo, programa: r.programa, nivel: r.nivel_academico, facultad: r.facultad, modalidad: r.modalidad,
        semestres: r.semestres_cursados ?? 0, ingreso: r.fecha_ingreso ? new Date(r.fecha_ingreso).toISOString().slice(0, 10) : null,
      }))
    },

    /** Estado académico actual de varios historiales: Map id → 'ACTIVO' | 'PAUSA' | 'RETIRADO' | 'GRADUADO'. */
    async estados(historiales) {
      if (!historiales.length) return new Map()
      const { rows } = await pool.query('SELECT id_historial, estado_academico FROM historial_estudiantes WHERE id_historial = ANY($1::bigint[])', [historiales])
      return new Map(rows.map((r) => [Number(r.id_historial), r.estado_academico]))
    },

    /** ¿El nombre del PID corresponde al del registro académico? (cada nombre y apellido del registro está en el PID) */
    mismoNombre: (e, nombresPid, apellidosPid) => {
      const pid = new Set([...normalizar(nombresPid), ...normalizar(apellidosPid)])
      return [...normalizar(e.nombres), ...normalizar(e.apellidos)].every((t) => pid.has(t))
    },
  }
}
