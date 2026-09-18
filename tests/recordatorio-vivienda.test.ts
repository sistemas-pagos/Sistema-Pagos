import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import { contextosPorRecordar, marcarRecordado } from '@/src/storage/mantenimiento';

/**
 * Un solo recordatorio a quien no contesto de que casa es su pago.
 *
 * Sin la marca de "ya se mando", cada corrida del worker —cada diez minutos—
 * volveria a mandarlo: seis mensajes por hora hasta que conteste. Eso no es
 * insistir, es acoso.
 */
const VENCIDO = '2026-09-16T10:00:00.000Z';
const AHORA = '2026-09-16T12:00:00.000Z';
const VIGENTE = '2026-09-16T14:00:00.000Z';

let db: Client;

beforeEach(async () => {
  db = await nuevaBaseDePrueba();
  await db.execute({
    sql: `INSERT INTO pagos (id, metodo, monto_centavos, estado, creado_en, actualizado_en)
          VALUES ('pay-1', 'TRANSFERENCIA', 15000, 'ESPERANDO_RESPUESTA', ?, ?)`,
    args: [VENCIDO, VENCIDO],
  });
});

afterEach(() => { db.close(); });

async function contexto(expira: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO contextos (id, pago_id, telefono, estado, expira_en, creado_en)
          VALUES ('ctx-1', 'pay-1', '50400000001', 'ABIERTO', ?, ?)`,
    args: [expira, VENCIDO],
  });
}

describe('a quien hay que recordarle', () => {
  it('encuentra el contexto vencido sin recordatorio', async () => {
    await contexto(VENCIDO);

    expect(await contextosPorRecordar(db, AHORA)).toEqual([{ id: 'ctx-1', telefono: '50400000001' }]);
  });

  /** Todavia puede contestar solo; recordarle ahora seria apurarlo. */
  it('no toca al que todavia tiene tiempo', async () => {
    await contexto(VIGENTE);

    expect(await contextosPorRecordar(db, AHORA)).toEqual([]);
  });

  it('no lo devuelve dos veces', async () => {
    await contexto(VENCIDO);
    await marcarRecordado(db, 'ctx-1', AHORA);

    expect(await contextosPorRecordar(db, AHORA)).toEqual([]);
  });

  /** Si el envio fallo no se marca, asi que la proxima corrida lo reintenta. */
  it('vuelve a aparecer si nunca se marco', async () => {
    await contexto(VENCIDO);
    await contextosPorRecordar(db, AHORA);

    expect(await contextosPorRecordar(db, AHORA)).toHaveLength(1);
  });

  it('no recuerda nada de un contexto ya cerrado', async () => {
    await contexto(VENCIDO);
    await db.execute("UPDATE contextos SET estado = 'EXPIRADO' WHERE id = 'ctx-1'");

    expect(await contextosPorRecordar(db, AHORA)).toEqual([]);
  });

  /** Una acumulacion rara no puede disparar cientos de mensajes de una vez. */
  it('respeta el limite por corrida', async () => {
    for (const numero of [2, 3, 4]) {
      await db.execute({
        sql: `INSERT INTO pagos (id, metodo, monto_centavos, estado, creado_en, actualizado_en)
              VALUES (?, 'TRANSFERENCIA', 15000, 'ESPERANDO_RESPUESTA', ?, ?)`,
        args: [`pay-${numero}`, VENCIDO, VENCIDO],
      });
      await db.execute({
        sql: `INSERT INTO contextos (id, pago_id, telefono, estado, expira_en, creado_en)
              VALUES (?, ?, '50400000002', 'ABIERTO', ?, ?)`,
        args: [`ctx-${numero}`, `pay-${numero}`, VENCIDO, VENCIDO],
      });
    }

    expect(await contextosPorRecordar(db, AHORA, 2)).toHaveLength(2);
  });
});
