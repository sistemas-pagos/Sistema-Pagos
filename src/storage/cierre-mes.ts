import { type Db, enTransaccion, registrarEvento } from '@/src/storage/turso';

/**
 * El cierre de mes: se cuadra lo cobrado y el mes queda bloqueado.
 *
 * Invariante 9: un mes cerrado no se modifica. Las correcciones entran como un
 * ajuste en el mes siguiente, no reescribiendo el pasado — que es como un
 * cuadre deja de cuadrar sin que nadie se entere.
 */

export interface ResumenDelMes {
  viviendasActivas: number;
  pagadas: number;
  porVerificar: number;
  enRevision: number;
  pendientes: number;
  /** Solo lo verificado, en centavos enteros (invariante 7). */
  cobradoCentavos: number;
  esperadoCentavos: number;
}

export interface CierreDelMes {
  periodo: string;
  cerradoPor: string;
  cerradoEn: string;
  resumen: ResumenDelMes;
}

/**
 * Cierra el mes. Devuelve `false` si ya estaba cerrado.
 *
 * La clave primaria de `cierres_mes` es el periodo, asi que cerrar dos veces no
 * puede pisar el cuadre anterior: el primero es el que vale, y el segundo no
 * reescribe nada.
 */
export async function cerrarMes(db: Db, cierre: CierreDelMes, actor: string): Promise<boolean> {
  return enTransaccion(db, async (tx) => {
    const resultado = await tx.execute({
      sql: `INSERT INTO cierres_mes (periodo, cerrado_por, cerrado_en, resumen_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (periodo) DO NOTHING`,
      args: [cierre.periodo, cierre.cerradoPor, cierre.cerradoEn, JSON.stringify(cierre.resumen)],
    });

    if (resultado.rowsAffected === 0) return false;

    // El resumen son cuentas y totales: ninguna casa, ningun monto por vivienda
    // (invariante 12).
    await registrarEvento(tx, {
      entidad: 'cierres_mes', entidadId: cierre.periodo, accion: 'CERRAR',
      despues: cierre.resumen, actor,
    }, cierre.cerradoEn);

    return true;
  });
}

/** Los periodos cerrados. Se leen una vez y se consultan muchas. */
export async function periodosCerrados(db: Db): Promise<Set<string>> {
  const { rows } = await db.execute('SELECT periodo FROM cierres_mes');
  return new Set(rows.map((fila) => String(fila.periodo)));
}

export async function mesEstaCerrado(db: Db, periodo: string): Promise<boolean> {
  const { rows } = await db.execute({
    sql: 'SELECT 1 FROM cierres_mes WHERE periodo = ?',
    args: [periodo],
  });
  return rows.length > 0;
}
