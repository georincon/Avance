// Los clientes del banco: un archivo JSON, solo para el ejemplo.
//
// Cada cliente se crea al abrir la cuenta con los datos que su wallet presentó
// (PID verificado por el verifier). La cédula (personal_administrative_number del
// PID) es la llave: con ella se le reconoce al ingresar.

import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function crearClientes(archivo) {
  if (!existsSync(archivo)) {
    mkdirSync(dirname(archivo), { recursive: true })
    writeFileSync(archivo, '[]\n')
  }
  const leer = () => JSON.parse(readFileSync(archivo, 'utf8'))
  const guardar = (lista) => {
    // Escribir aparte y renombrar: el archivo nunca queda a medias.
    writeFileSync(`${archivo}.tmp`, `${JSON.stringify(lista, null, 2)}\n`)
    renameSync(`${archivo}.tmp`, archivo)
  }

  return {
    buscar: (cedula) => leer().find((c) => c.cedula === cedula) ?? null,

    crear(datos) {
      const lista = leer()
      if (lista.some((c) => c.cedula === datos.cedula)) throw new Error('ya existe')
      const cliente = {
        ...datos,
        cuenta: `${randomInt(100, 999)}-${randomInt(100000, 999999)}-${randomInt(10, 99)}`,
        saldo: 50000, // bono de bienvenida, para que la cuenta no se vea vacía
        movimientos: [{ fecha: new Date().toISOString(), concepto: 'Bono de bienvenida', valor: 50000 }],
        creado: new Date().toISOString(),
      }
      lista.push(cliente)
      guardar(lista)
      return cliente
    },

    registrarIngreso(cedula) {
      const lista = leer()
      const cliente = lista.find((c) => c.cedula === cedula)
      if (cliente) {
        cliente.ultimo_ingreso = new Date().toISOString()
        guardar(lista)
      }
      return cliente
    },
  }
}
