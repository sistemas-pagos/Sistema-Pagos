import { type Db, enTransaccion, registrarEvento } from '@/src/storage/turso';

/**
 * Los barridos que nadie dispara y sin los cuales las cosas se quedan quietas.
 *
 * Un contexto vencido no molesta a nadie —al leerlo ya se descarta—, y por eso
 * mismo el pago que colgaba de el se queda en `ESPERANDO_RESPUESTA` para
 * siempre, con la plata ya en el banco y sin que ninguna pantalla lo muestre.
 * Un silencio asi es peor que un error: el error se ve.
 */

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
