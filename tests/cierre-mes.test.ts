import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import { resetEnvForTests } from '@/src/config/env';
import type { HomeRecord, MonthlyHomeStatusRow, PaymentRecord } from '@/src/domain/types';
import { calcularCierre, resumirMes } from '@/src/services/cierre-mes';
import { cerrarMes, mesEstaCerrado, periodosCerrados } from '@/src/storage/cierre-mes';
import { TursoPaymentStore } from '@/src/storage/turso-store';

/**
 * El cierre de mes (fase 7).
 *
 * Lo que estas pruebas cuidan no es el conteo: es que despues de cerrar, el mes
 * **no se pueda tocar** (invariante 9). Un cuadre guardado que se puede
 * contradecir despues no sirve de nada — nadie podria decir cual de los dos
 * numeros es el bueno, ni en que momento dejo de serlo.
 */
let db: Client;
let store: TursoPaymentStore;

const CASA: HomeRecord = {
  id: 'v1', stage: '1', block: '4', house: '18', monthlyFee: 150, active: true, startDate: '2026-09-01',
};

const RESUMEN = {
  viviendasActivas: 1, pagadas: 1, porVerificar: 0, enRevision: 0, pendientes: 0,
  cobradoCentavos: 15_000, esperadoCentavos: 15_000,
};

function fila(overrides: Partial<MonthlyHomeStatusRow> = {}): MonthlyHomeStatusRow {
  return {
    period: '2026-09', homeId: 'v1', stage: '1', block: '4', house: '18', monthlyFee: 150,
    status: 'PENDIENTE', receivedAmount: 0, paymentCount: 0, ...overrides,
  };
}

function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
    sourceMessageId: 'msg-1', phone: '50400000001', bank: 'BAC Honduras', amount: 150,
    transactionDate: '2026-09-02', reference: '412000001', stage: '1', block: '4', house: '18',
    period: '2026-09', status: 'PENDIENTE_VERIFICACION', fileHash: 'sha-1', ...overrides,
  };
}

async function mensajeRecibido(messageId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO mensajes (message_id, telefono, tipo, estado, recibido_en, actualizado_en)
          VALUES (?, '50400000001', 'image', 'RECIBIDO', ?, ?)`,
    args: [messageId, '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'],
  });
}

async function guardar(registro: PaymentRecord): Promise<void> {
  if (registro.sourceMessageId) await mensajeRecibido(registro.sourceMessageId);
  await store.savePayment(registro);
}

/** `cierres_mes.cerrado_por` apunta a `usuarios`: sin tesorero no hay cierre. */
async function tesorero(): Promise<void> {
  await db.execute({
    sql: "INSERT INTO usuarios (id, nombre, rol) VALUES ('u-tesorero', 'Tesorero', 'TESORERO')",
  });
}

async function cerrar(periodo: string): Promise<boolean> {
  return cerrarMes(db, {
    periodo, cerradoPor: 'u-tesorero', cerradoEn: '2026-10-01T12:00:00.000Z', resumen: RESUMEN,
  }, 'prueba');
}

beforeEach(async () => {
  process.env.APP_MODE = 'demo';
  resetEnvForTests();
  db = await nuevaBaseDePrueba();
  store = new TursoPaymentStore(db);
  await store.saveHomes([CASA]);
  await tesorero();
});

afterEach(() => {
  db.close();
  delete process.env.APP_MODE;
  resetEnvForTests();
});

describe('el cuadre del mes', () => {
  it('cuenta cada casa segun como termino el mes', () => {
    const resumen = resumirMes([
      fila({ homeId: 'v1', status: 'PAGADO' }),
      fila({ homeId: 'v2', status: 'POR_VERIFICAR' }),
      fila({ homeId: 'v3', status: 'EN_REVISION' }),
      fila({ homeId: 'v4', status: 'PENDIENTE' }),
    ]);

    expect(resumen).toMatchObject({
      viviendasActivas: 4, pagadas: 1, porVerificar: 1, enRevision: 1, pendientes: 1,
    });
  });

  /**
   * Recibido no es verificado (invariante 2). Una casa POR_VERIFICAR mando su
   * comprobante pero el banco todavia no lo respaldo: contarla como cobrada
   * seria cuadrar con plata que quizas nunca entro.
   */
  it('solo suma como cobrado lo que quedo verificado', () => {
    const resumen = resumirMes([
      fila({ homeId: 'v1', status: 'PAGADO' }),
      fila({ homeId: 'v2', status: 'POR_VERIFICAR' }),
      fila({ homeId: 'v3', status: 'EN_REVISION' }),
    ]);

    expect(resumen.cobradoCentavos).toBe(15_000);
    expect(resumen.esperadoCentavos).toBe(45_000);
  });

  it('lleva los totales en centavos enteros', () => {
    expect(resumirMes([fila({ monthlyFee: 150.55, status: 'PAGADO' })]).cobradoCentavos).toBe(15_055);
  });

  it('se arma desde los pagos que la base tiene', async () => {
    await guardar(pago({ status: 'VERIFICADO' }));

    const resumen = await calcularCierre(store, '2026-09');

    expect(resumen).toMatchObject({ viviendasActivas: 1, pagadas: 1, cobradoCentavos: 15_000 });
  });
});

describe('cerrar el mes', () => {
  it('guarda el cuadre y deja constancia de quien cerro', async () => {
    expect(await cerrar('2026-09')).toBe(true);

    const { rows } = await db.execute("SELECT cerrado_por, resumen_json FROM cierres_mes WHERE periodo = '2026-09'");
    expect(rows[0].cerrado_por).toBe('u-tesorero');
    expect(JSON.parse(String(rows[0].resumen_json))).toEqual(RESUMEN);

    const eventos = await db.execute("SELECT actor, entidad_id FROM eventos WHERE entidad = 'cierres_mes'");
    expect(eventos.rows[0]).toMatchObject({ actor: 'prueba', entidad_id: '2026-09' });
  });

  /**
   * Cerrar dos veces no puede pisar el cuadre anterior: el primero es el que
   * vale. Si el segundo reescribiera, bastaria con volver a correr el workflow
   * despues de un cambio para que el numero guardado lo tapara.
   */
  it('no hace nada si el mes ya estaba cerrado', async () => {
    await cerrar('2026-09');

    const segundo = await cerrarMes(db, {
      periodo: '2026-09', cerradoPor: 'u-tesorero', cerradoEn: '2026-11-01T12:00:00.000Z',
      resumen: { ...RESUMEN, pagadas: 99, cobradoCentavos: 1 },
    }, 'prueba');

    expect(segundo).toBe(false);

    const { rows } = await db.execute("SELECT cerrado_en, resumen_json FROM cierres_mes WHERE periodo = '2026-09'");
    expect(rows[0].cerrado_en).toBe('2026-10-01T12:00:00.000Z');
    expect(JSON.parse(String(rows[0].resumen_json)).pagadas).toBe(1);
    expect(await db.execute("SELECT count(*) AS c FROM eventos WHERE entidad = 'cierres_mes'")
      .then(({ rows: e }) => Number(e[0].c))).toBe(1);
  });

  it('dice que periodos estan cerrados', async () => {
    await cerrar('2026-09');

    expect(await mesEstaCerrado(db, '2026-09')).toBe(true);
    expect(await mesEstaCerrado(db, '2026-10')).toBe(false);
    expect(await periodosCerrados(db)).toEqual(new Set(['2026-09']));
  });
});

describe('un mes cerrado no se modifica', () => {
  it('rechaza cambiar un pago del mes cerrado', async () => {
    await guardar(pago());
    await cerrar('2026-09');

    await expect(store.updatePayment({ ...pago(), status: 'RECHAZADO' }, { actor: 'panel' }))
      .rejects.toThrow('month_already_closed');

    const { rows } = await db.execute("SELECT estado FROM pagos WHERE id = 'pay-1'");
    expect(rows[0].estado).toBe('PENDIENTE_VERIFICACION');
  });

  it('rechaza verificar un pago del mes cerrado', async () => {
    await guardar(pago());
    await cerrar('2026-09');

    await expect(store.verifyPayment({ ...pago(), status: 'VERIFICADO' }, 'u-tesorero'))
      .rejects.toThrow('month_already_closed');

    expect(await db.execute('SELECT count(*) AS c FROM recibos').then(({ rows }) => Number(rows[0].c))).toBe(0);
  });

  /**
   * Mover el pago **fuera** del mes cerrado tambien cambia ese mes: la casa que
   * figuraba pagada en septiembre deja de figurar. Si solo se mirara el periodo
   * nuevo, esta seria la forma de tocar un mes cerrado igual, y el cuadre
   * guardado quedaria mintiendo sin que nadie lo note.
   */
  it('rechaza sacar un pago de un mes cerrado hacia uno abierto', async () => {
    await guardar(pago());
    await cerrar('2026-09');

    await expect(store.updatePayment({ ...pago(), period: '2026-10' }, { actor: 'panel' }))
      .rejects.toThrow('month_already_closed');
  });

  it('rechaza meter un pago de un mes abierto a uno cerrado', async () => {
    await guardar(pago({ period: '2026-10' }));
    await cerrar('2026-09');

    await expect(store.updatePayment({ ...pago(), period: '2026-09' }, { actor: 'panel' }))
      .rejects.toThrow('month_already_closed');
  });

  /** Lo demas sigue igual: cerrar septiembre no congela octubre. */
  it('deja trabajar los meses que siguen abiertos', async () => {
    await guardar(pago({ period: '2026-10' }));
    await cerrar('2026-09');

    await store.updatePayment({ ...pago(), period: '2026-10', status: 'EN_REVISION' }, { actor: 'panel' });

    const { rows } = await db.execute("SELECT estado FROM pagos WHERE id = 'pay-1'");
    expect(rows[0].estado).toBe('EN_REVISION');
  });

  /** Un pago sin mes asignado todavia no pertenece a ningun cierre. */
  it('no bloquea un pago que no tiene mes asignado', async () => {
    await guardar(pago({ period: '' }));
    await cerrar('2026-09');

    await store.updatePayment({ ...pago(), period: '', status: 'EN_REVISION' }, { actor: 'panel' });

    const { rows } = await db.execute("SELECT estado FROM pagos WHERE id = 'pay-1'");
    expect(rows[0].estado).toBe('EN_REVISION');
  });
});
