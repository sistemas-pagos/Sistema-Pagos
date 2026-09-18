import { type Db, enTransaccion, registrarEvento } from '@/src/storage/turso';

/**
 * Los barridos que nadie dispara y sin los cuales las cosas se quedan quietas.
 *
 * Un contexto vencido no molesta a nadie —al leerlo ya se descarta—, y por eso
 * mismo el pago que colgaba de el se queda en `ESPERANDO_RESPUESTA` para
 * siempre, con la plata ya en el banco y sin que ninguna pantalla lo muestre.
 * Un silencio asi es peor que un error: el error se ve.
 */

export interface ContextoPorRecordar {
  id: string;
  telefono: string;
}

/**
 * Contextos que vencieron sin respuesta y a los que todavia no se les mando el
 * recordatorio.
 *
 * Va aparte del barrido diario porque un recordatorio que llega al otro dia no
 * sirve: para entonces el vecino ya no se acuerda de que comprobante hablamos.
 * Lo corre el worker, que pasa cada diez minutos.
 *
 * El limite existe para que una acumulacion rara no dispare cientos de mensajes
 * en una sola corrida; lo que sobra espera diez minutos.
 */
export async function contextosPorRecordar(db: Db, ahora: string, limite = 50): Promise<ContextoPorRecordar[]> {
  const { rows } = await db.execute({
    sql: `SELECT id, telefono FROM contextos
          WHERE estado = 'ABIERTO' AND expira_en <= ? AND recordado_en IS NULL
          ORDER BY creado_en LIMIT ?`,
    args: [ahora, limite],
  });

  return rows.map((fila) => ({ id: String(fila.id), telefono: String(fila.telefono) }));
}

/** Se marca despues de mandarlo: si el envio falla, se reintenta en la proxima. */
export async function marcarRecordado(db: Db, id: string, ahora: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE contextos SET recordado_en = ? WHERE id = ? AND recordado_en IS NULL',
    args: [ahora, id],
  });
}

/** Por que quedo para una persona, cuando el vecino nunca contesto. */
export const MOTIVO_SIN_RESPUESTA = 'home_reply_timeout';

export interface ResultadoBarrido {
  contextos: number;
  pagos: number;
}

/**
 * Cierra los contextos vencidos y manda a revision el pago que esperaba
 * (docs/PLAN.md, fase 1).
 *
 * El pago solo cambia si sigue esperando: entre que el contexto vencio y corre
 * el barrido, el vecino pudo contestar y el pago ya estar en camino. Mover un
 * pago que avanzo seria hacerle perder el lugar a alguien que si respondio.
 */
export async function expirarContextos(db: Db, ahora: string, actor: string): Promise<ResultadoBarrido> {
  return enTransaccion(db, async (tx) => {
    const { rows } = await tx.execute({
      sql: "SELECT id, pago_id FROM contextos WHERE estado = 'ABIERTO' AND expira_en <= ?",
      args: [ahora],
    });

    let pagos = 0;
    for (const fila of rows) {
      const contextoId = String(fila.id);
      const pagoId = String(fila.pago_id);

      await tx.execute({
        sql: "UPDATE contextos SET estado = 'EXPIRADO' WHERE id = ? AND estado = 'ABIERTO'",
        args: [contextoId],
      });

      const pago = await tx.execute({
        sql: `UPDATE pagos SET estado = 'EN_REVISION', motivo_revision = ?, actualizado_en = ?
              WHERE id = ? AND estado = 'ESPERANDO_RESPUESTA'`,
        args: [MOTIVO_SIN_RESPUESTA, ahora, pagoId],
      });

      if (pago.rowsAffected > 0) {
        pagos += 1;
        await registrarEvento(tx, {
          entidad: 'pagos', entidadId: pagoId, accion: 'ACTUALIZAR',
          antes: { estado: 'ESPERANDO_RESPUESTA' },
          despues: { estado: 'EN_REVISION' },
          motivo: MOTIVO_SIN_RESPUESTA, actor,
        }, ahora);
      }
    }

    return { contextos: rows.length, pagos };
  });
}
