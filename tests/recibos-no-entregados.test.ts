import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, CUOTA_CENTAVOS, PLANTILLA, nuevaBaseDePrueba, sembrar } from './helpers/turso-test-db';
import { recibosNoEntregados } from '@/src/storage/envios';
import {
  crearPago, crearVivienda, marcarEnvioEnviado, marcarEnvioFallido,
  reemitirRecibo, reservarMeses, verificarPagoConMovimiento,
} from '@/src/storage/turso';

/**
 * El recibo que no llego.
 *
 * Un pago verificado que no avisa a nadie deja al vecino pagado y sin nada en
 * la mano, mientras el tablero se ve perfecto. Estas pruebas cuidan que esa
 * situacion **se vea**, que es lo unico que hoy faltaba: la fila ya existia en
 * `envios` y ninguna pantalla la miraba.
 */
const ALTA = '2026-09-01T00:00:00.000Z';
const TELEFONO = '+50433330000';
const AHORA = new Date('2026-09-20T12:00:00.000Z');
/** Mas de seis horas antes de AHORA: ya no es espera normal del cron. */
const VIEJO = '2026-09-20T02:00:00.000Z';

let db: Client;

beforeEach(async () => { db = await nuevaBaseDePrueba(); await sembrar(db); });
afterEach(() => { db.close(); });

/** Una vivienda con un pago verificado: deja recibo EMITIDO y envio PENDIENTE. */
async function reciboEmitido(
  pagoId: string,
  movimientoId: string,
  opciones: { telefono?: string; codigoCasa?: string } = {},
): Promise<number> {
  const casa = opciones.codigoCasa ?? '18';
  const viviendaId = `v-${casa}`;
  const { rows } = await db.execute({ sql: 'SELECT id FROM viviendas WHERE id = ?', args: [viviendaId] });
  if (rows.length === 0) {
    await crearVivienda(db, {
      id: viviendaId, etapa: '1', bloque: '4', casa, estado: 'ACTIVA', fechaAlta: ALTA,
    }, ACTOR);
  }

  await crearPago(db, {
    id: pagoId,
    metodo: 'TRANSFERENCIA',
    viviendaId,
    montoCentavos: CUOTA_CENTAVOS,
    estado: 'PENDIENTE_VERIFICACION',
    telefonoContacto: opciones.telefono ?? TELEFONO,
    creadoEn: ALTA,
  }, ACTOR);
  await reservarMeses(db, {
    pagoId, viviendaId, meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }],
    actor: ACTOR, creadoEn: ALTA,
  });

  return verificarPagoConMovimiento(db, {
    pagoId, movimientoId, verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
  }, ACTOR);
}

/** Empuja la fila hacia atras en el tiempo, como si llevara horas sin moverse. */
async function envejecerEnvio(reciboNumero: number, cuando = VIEJO): Promise<void> {
  await db.execute({
    sql: 'UPDATE envios SET actualizado_en = ? WHERE recibo_numero = ?',
    args: [cuando, reciboNumero],
  });
}

describe('los recibos que no llegaron', () => {
  it('un envio entregado no aparece', async () => {
    const numero = await reciboEmitido('p1', 'mov1');
    await marcarEnvioEnviado(db, { id: `env-${numero}`, waMessageId: 'wamid.1', en: ALTA });

    expect(await recibosNoEntregados(db, AHORA)).toEqual([]);
  });

  it('un envio que agoto los intentos sale como FALLIDO, con su error y su cuenta', async () => {
    const numero = await reciboEmitido('p1', 'mov1');
    for (let intento = 0; intento < 5; intento += 1) {
      await marcarEnvioFallido(db, { id: `env-${numero}`, error: 'whatsapp_template_failed:400', en: ALTA });
    }

    const [fila] = await recibosNoEntregados(db, AHORA);
    expect(fila).toMatchObject({
      reciboNumero: numero,
      vivienda: 'E1B4C18',
      telefono: TELEFONO,
      motivo: 'FALLIDO',
      intentos: 5,
      error: 'whatsapp_template_failed:400',
    });
  });

  /**
   * La falla peligrosa: si el workflow no corre, el envio se queda en PENDIENTE
   * con cero intentos y nunca llega a FALLIDO. Sin este caso, una cola detenida
   * seria invisible.
   */
  it('un PENDIENTE que lleva horas sin moverse sale como ATASCADO', async () => {
    const numero = await reciboEmitido('p1', 'mov1');
    await envejecerEnvio(numero);

    const [fila] = await recibosNoEntregados(db, AHORA);
    expect(fila).toMatchObject({ reciboNumero: numero, motivo: 'ATASCADO', intentos: 0 });
    expect(fila.error).toBeUndefined();
  });

  it('un PENDIENTE recien encolado no alarma: espera la proxima corrida', async () => {
    await reciboEmitido('p1', 'mov1');
    await db.execute("UPDATE envios SET actualizado_en = '2026-09-20T11:50:00.000Z'");

    expect(await recibosNoEntregados(db, AHORA)).toEqual([]);
  });

  /**
   * El cron pide cada quince minutos pero corre cada ~2 horas: GitHub retrasa
   * el schedule. Un envio de hace tres horas todavia puede estar esperando su corrida, y
   * marcarlo seria una alarma falsa en cada recibo que se emite.
   */
  it('dos horas de espera no son una alarma: el cron no corre cada quince minutos', async () => {
    await reciboEmitido('p1', 'mov1');
    await db.execute("UPDATE envios SET actualizado_en = '2026-09-20T09:00:00.000Z'");

    expect(await recibosNoEntregados(db, AHORA)).toEqual([]);
  });

  /**
   * Un recibo anulado se reemplazo por otro a proposito (invariante 10). Su
   * envio nunca va a salir, y listarlo como "no entregado" seria una alarma
   * falsa que compite con las de verdad.
   */
  it('el envio de un recibo anulado no cuenta como no entregado', async () => {
    const numero = await reciboEmitido('p1', 'mov1');
    await envejecerEnvio(numero);
    const reemplazo = await reemitirRecibo(db, {
      numero, motivo: 'monto corregido', actor: ACTOR, en: ALTA, plantilla: PLANTILLA,
    });
    expect(reemplazo).not.toBe(numero);

    const sinEntregar = await recibosNoEntregados(db, AHORA);
    expect(sinEntregar.map((fila) => fila.reciboNumero)).not.toContain(numero);
  });

  it('lo mas viejo sale primero, que es lo que lleva mas tiempo sin llegar', async () => {
    const primero = await reciboEmitido('p1', 'mov1', { codigoCasa: '18' });
    const segundo = await reciboEmitido('p2', 'mov2', { codigoCasa: '19' });
    await envejecerEnvio(primero, '2026-09-20T04:00:00.000Z');
    await envejecerEnvio(segundo, '2026-09-20T02:00:00.000Z');

    const orden = (await recibosNoEntregados(db, AHORA)).map((fila) => fila.reciboNumero);
    expect(orden).toEqual([segundo, primero]);
  });

  it('el umbral de atascado es configurable', async () => {
    const numero = await reciboEmitido('p1', 'mov1');
    await envejecerEnvio(numero, '2026-09-20T11:30:00.000Z');

    expect(await recibosNoEntregados(db, AHORA, 60)).toEqual([]);
    expect((await recibosNoEntregados(db, AHORA, 15))[0]).toMatchObject({ motivo: 'ATASCADO' });
  });
});
