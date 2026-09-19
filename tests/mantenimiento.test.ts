import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, nuevaBaseDePrueba } from './helpers/turso-test-db';
import { MOTIVO_SIN_RESPUESTA, expirarContextos } from '@/src/storage/mantenimiento';

/**
 * Sin este barrido, un pago cuyo contexto vencio se queda en
 * `ESPERANDO_RESPUESTA` para siempre: el contexto ya no molesta a nadie porque
 * se descarta al leerlo, y por eso mismo nadie vuelve a mirar el pago. La plata
 * esta en el banco y ninguna pantalla lo muestra.
 */
const VENCIDO = '2026-09-16T10:00:00.000Z';
const AHORA = '2026-09-16T12:00:00.000Z';
const VIGENTE = '2026-09-16T14:00:00.000Z';

let db: Client;

beforeEach(async () => {
  db = await nuevaBaseDePrueba();
  await db.execute({
    sql: `INSERT INTO mensajes (message_id, telefono, tipo, estado, recibido_en, actualizado_en)
          VALUES ('msg-1', '50400000001', 'image', 'PROCESADO', ?, ?)`,
    args: [VENCIDO, VENCIDO],
  });
});

afterEach(() => { db.close(); });

async function pagoEsperando(id: string, estado = 'ESPERANDO_RESPUESTA'): Promise<void> {
  await db.execute({
    sql: `INSERT INTO pagos (id, metodo, monto_centavos, estado, creado_en, actualizado_en)
          VALUES (?, 'TRANSFERENCIA', 15000, ?, ?, ?)`,
    args: [id, estado, VENCIDO, VENCIDO],
  });
}

async function contexto(id: string, pagoId: string, expira: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO contextos (id, pago_id, telefono, estado, expira_en, creado_en)
          VALUES (?, ?, '50400000001', 'ABIERTO', ?, ?)`,
    args: [id, pagoId, expira, VENCIDO],
  });
}

async function estadoDelPago(id: string): Promise<{ estado: string; motivo: string | null }> {
  const { rows } = await db.execute({ sql: 'SELECT estado, motivo_revision FROM pagos WHERE id = ?', args: [id] });
  return { estado: String(rows[0].estado), motivo: rows[0].motivo_revision as string | null };
}

describe('contextos que nadie contesto', () => {
  it('cierra el contexto y manda el pago a una persona', async () => {
    await pagoEsperando('pay-1');
    await contexto('ctx-1', 'pay-1', VENCIDO);

    expect(await expirarContextos(db, AHORA, ACTOR)).toEqual({ contextos: 1, pagos: 1 });

    expect(await estadoDelPago('pay-1')).toEqual({ estado: 'EN_REVISION', motivo: MOTIVO_SIN_RESPUESTA });
    const { rows } = await db.execute("SELECT estado FROM contextos WHERE id = 'ctx-1'");
    expect(rows[0].estado).toBe('EXPIRADO');
  });

  it('no toca el que todavia tiene tiempo', async () => {
    await pagoEsperando('pay-1');
    await contexto('ctx-1', 'pay-1', VIGENTE);

    expect(await expirarContextos(db, AHORA, ACTOR)).toEqual({ contextos: 0, pagos: 0 });
    expect((await estadoDelPago('pay-1')).estado).toBe('ESPERANDO_RESPUESTA');
  });

  /**
   * Entre que el contexto vencio y corre el barrido, el vecino pudo contestar.
   * Mover ese pago seria hacerle perder el lugar a alguien que si respondio.
   */
  it('no mueve un pago que ya avanzo', async () => {
    await pagoEsperando('pay-1', 'PENDIENTE_VERIFICACION');
    await contexto('ctx-1', 'pay-1', VENCIDO);

    expect(await expirarContextos(db, AHORA, ACTOR)).toEqual({ contextos: 1, pagos: 0 });

    expect((await estadoDelPago('pay-1')).estado).toBe('PENDIENTE_VERIFICACION');
  });

  /** Correrlo dos veces no puede contar lo mismo dos veces. */
  it('no vuelve a barrer lo que ya barrio', async () => {
    await pagoEsperando('pay-1');
    await contexto('ctx-1', 'pay-1', VENCIDO);
    await expirarContextos(db, AHORA, ACTOR);

    expect(await expirarContextos(db, AHORA, ACTOR)).toEqual({ contextos: 0, pagos: 0 });
  });

  it('deja constancia de por que quedo en revision', async () => {
    await pagoEsperando('pay-1');
    await contexto('ctx-1', 'pay-1', VENCIDO);
    await expirarContextos(db, AHORA, ACTOR);

    const { rows } = await db.execute("SELECT motivo, antes_json, despues_json FROM eventos WHERE entidad = 'pagos'");
    expect(rows[0].motivo).toBe(MOTIVO_SIN_RESPUESTA);
    expect(JSON.parse(String(rows[0].antes_json))).toEqual({ estado: 'ESPERANDO_RESPUESTA' });
    expect(JSON.parse(String(rows[0].despues_json))).toEqual({ estado: 'EN_REVISION' });
  });

  /** El evento no dice de que casa ni de que telefono era (invariante 12). */
  it('el evento no trae datos del vecino', async () => {
    await pagoEsperando('pay-1');
    await contexto('ctx-1', 'pay-1', VENCIDO);
    await expirarContextos(db, AHORA, ACTOR);

    const { rows } = await db.execute("SELECT despues_json FROM eventos WHERE entidad = 'pagos'");
    expect(String(rows[0].despues_json)).not.toContain('504');
  });

  it('barre varios de una sola pasada', async () => {
    for (const numero of [1, 2, 3]) {
      await pagoEsperando(`pay-${numero}`);
      await contexto(`ctx-${numero}`, `pay-${numero}`, VENCIDO);
    }

    expect(await expirarContextos(db, AHORA, ACTOR)).toEqual({ contextos: 3, pagos: 3 });
  });
});
