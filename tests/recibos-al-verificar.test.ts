import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nuevaBaseDePrueba, sembrar } from './helpers/turso-test-db';
import { resetEnvForTests } from '@/src/config/env';
import { formatoRecibo } from '@/src/domain/recibo';
import type { PaymentRecord } from '@/src/domain/types';
import { reconcilePendingPayments } from '@/src/services/reconciliation';
import { MemoryPaymentStore } from '@/src/storage/memory';
import { TursoPaymentStore } from '@/src/storage/turso-store';

/**
 * El vecino paga, el banco confirma, y hasta ahora no le llegaba nada.
 *
 * `emitirRecibo` estaba escrito y probado desde la fase 4, y ninguna ruta viva
 * lo llamaba: los pagos vivian en Google Sheets y el talonario en Turso. Estas
 * pruebas son las que impiden que vuelva a desconectarse.
 */
function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
    sourceMessageId: 'msg-1', phone: '50400000001', bank: 'BAC Honduras', amount: 150,
    transactionDate: '2026-09-02', reference: '412000001', stage: '1', block: '4', house: '18',
    period: '2026-09', status: 'PENDIENTE_VERIFICACION', fileHash: 'sha-1', ...overrides,
  };
}

const DEPOSITO = { id: 'mov-1', bank: 'BAC Honduras', reference: '412000001', amount: 150, transactionDate: '2026-09-02' };
const AL_VERIFICAR = new Date('2026-09-16T12:00:00.000Z');

beforeEach(() => {
  delete process.env.EXPECTED_PAYMENT_AMOUNT;
  resetEnvForTests();
});

describe('conciliar emite el recibo', () => {
  it('cuenta un recibo por cada pago verificado', async () => {
    const store = new MemoryPaymentStore({ payments: [pago()] });

    const resumen = await reconcilePendingPayments(store, [DEPOSITO], 'extracto-bac', AL_VERIFICAR);

    expect(resumen.verified).toBe(1);
    expect(resumen.receipts).toBe(1);
    expect(store.receiptFor('pay-1')).toBe(1);
  });

  /** Un pago que no se verifica no genera recibo: no hay nada que certificar. */
  it('no emite recibo para lo que queda en revision o sin respaldo', async () => {
    const store = new MemoryPaymentStore({ payments: [pago({ reference: '999999999' })] });

    const resumen = await reconcilePendingPayments(store, [DEPOSITO], 'extracto-bac', AL_VERIFICAR);

    expect(resumen.notFound).toBe(1);
    expect(resumen.receipts).toBe(0);
    expect(store.receiptFor('pay-1')).toBeUndefined();
  });

  /** La secuencia es global y no se repite (invariante 10). */
  it('da un numero distinto a cada recibo', async () => {
    const store = new MemoryPaymentStore({ payments: [
      pago(),
      pago({ id: 'pay-2', sourceMessageId: 'msg-2', fileHash: 'sha-2', reference: '412000002', house: '19' }),
    ] });
    const depositos = [DEPOSITO, { ...DEPOSITO, id: 'mov-2', reference: '412000002' }];

    await reconcilePendingPayments(store, depositos, 'extracto-bac', AL_VERIFICAR);

    expect(store.receiptFor('pay-1')).not.toBe(store.receiptFor('pay-2'));
  });
});

describe('el recibo en Turso', () => {
  let db: Client;
  let store: TursoPaymentStore;

  beforeEach(async () => {
    process.env.APP_MODE = 'demo';
    resetEnvForTests();
    db = await nuevaBaseDePrueba();
    // Trae un usuario, una importacion y dos movimientos de banco.
    await sembrar(db);
    store = new TursoPaymentStore(db);
    await store.saveHomes([{ id: 'v1', stage: '1', block: '4', house: '18', monthlyFee: 150, active: true, startDate: '2026-09-01' }]);
    await db.execute({
      sql: `INSERT INTO mensajes (message_id, telefono, tipo, estado, recibido_en, actualizado_en)
            VALUES ('msg-1', '50400000001', 'image', 'PROCESADO', ?, ?)`,
      args: ['2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'],
    });
    await store.savePayment(pago());
  });

  afterEach(() => {
    db.close();
    delete process.env.APP_MODE;
    resetEnvForTests();
  });

  const verificado = () => pago({
    status: 'VERIFICADO', verifiedAt: AL_VERIFICAR.toISOString(), updatedAt: AL_VERIFICAR.toISOString(),
    verificationSource: 'extracto-bac', bankMovementId: 'mov1',
  });

  it('queda emitido y encolado para enviar, con el pago verificado', async () => {
    const numero = await store.verifyPayment(verificado());

    expect(formatoRecibo(numero)).toMatch(/^REC-\d{6}$/);
    const recibo = await db.execute('SELECT numero, pago_id, estado FROM recibos');
    expect(recibo.rows[0]).toMatchObject({ numero, pago_id: 'pay-1', estado: 'EMITIDO' });
    const envio = await db.execute('SELECT estado, telefono FROM envios');
    expect(envio.rows[0]).toMatchObject({ estado: 'PENDIENTE', telefono: '50400000001' });
    const pagoGuardado = await db.execute("SELECT estado FROM pagos WHERE id = 'pay-1'");
    expect(pagoGuardado.rows[0].estado).toBe('VERIFICADO');
  });

  /**
   * Si fueran dos pasos, un fallo entre medio dejaria un pago verificado sin
   * recibo: el vecino pago, el sistema lo sabe, y nunca le llega nada. Desde el
   * tablero ese pago se ve perfecto, asi que nadie se entera.
   */
  it('no verifica si el recibo no se puede emitir', async () => {
    // Ya tiene un recibo emitido: `ux_recibo_activo` no deja emitir otro.
    await db.execute({
      sql: "INSERT INTO recibos (pago_id, estado, emitido_en) VALUES ('pay-1', 'EMITIDO', ?)",
      args: [AL_VERIFICAR.toISOString()],
    });

    await expect(store.verifyPayment(verificado())).rejects.toThrow();

    const pagoGuardado = await db.execute("SELECT estado FROM pagos WHERE id = 'pay-1'");
    expect(pagoGuardado.rows[0].estado).toBe('PENDIENTE_VERIFICACION');
  });

  it('deja constancia de quien lo verifico', async () => {
    await store.verifyPayment(verificado(), 'u1');

    const { rows } = await db.execute("SELECT verificado_por FROM pagos WHERE id = 'pay-1'");
    expect(rows[0].verificado_por).toBe('u1');
    const evento = await db.execute("SELECT actor FROM eventos WHERE accion = 'VERIFICAR'");
    expect(evento.rows[0].actor).toBe('u1');
  });

  /** El mes deja de estar apartado y queda cobrado (invariante 5). */
  it('pasa el mes de reservado a pagado', async () => {
    await db.execute(`INSERT INTO pago_meses (pago_id, vivienda_id, periodo, monto_centavos, estado)
                      VALUES ('pay-1', 'v1', '2026-09', 15000, 'RESERVADO')`);

    await store.verifyPayment(verificado());

    const { rows } = await db.execute('SELECT estado FROM pago_meses');
    expect(rows[0].estado).toBe('PAGADO');
  });
});
