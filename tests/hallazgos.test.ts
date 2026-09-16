import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { SYNTHETIC_BAC_RECEIPTS } from '@/src/demo/data';
import { parseHomeReference } from '@/src/domain/housing';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { bacParser } from '@/src/parsers/bac';
import { canManuallyVerify } from '@/src/services/manual-verification';
import { processReceiptMessage } from '@/src/services/payment-processor';
import { assignServicePeriod } from '@/src/services/period-assignment';
import { MemoryPaymentStore } from '@/src/storage/memory';

const homes: HomeRecord[] = [{ id: 'h', stage: '1', block: '4', house: '18', monthlyFee: 150, active: true }];
const png = (v: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, v]);
const base = (over: Partial<PaymentRecord>): PaymentRecord => ({
  id: 'p', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceMessageId: 'm',
  phone: '+50400000000', bank: 'BAC Honduras', amount: 150, stage: '1', block: '4', house: '18',
  period: '2026-08', status: 'VERIFICADO', fileHash: 'h', ...over,
});
const receipt = (date: string, ref: string, extra = '') => SYNTHETIC_BAC_RECEIPTS.valid
  .replace('07/09/2026', date).replace('DEMOREF000001', ref) + extra;

beforeEach(() => { process.env.APP_MODE = 'demo'; delete process.env.EXPECTED_BENEFICIARY; resetEnvForTests(); });
afterEach(() => {
  delete process.env.APP_MODE;
  delete process.env.EXPECTED_BENEFICIARY;
  delete process.env.EXPECTED_ACCOUNT_LAST4;
  resetEnvForTests();
});

describe('hallazgos', () => {
  it('H1 corregido: el formato compacto E1B4C18 se reconoce', () => {
    const esperado = { stage: '1', block: '4', house: '18' };
    expect(parseHomeReference('E1 B4 C18')).toEqual(esperado);
    expect(parseHomeReference('E1B4C18')).toEqual(esperado);
    expect(parseHomeReference('e1b4c18')).toEqual(esperado);
    expect(parseHomeReference('Etapa1Bloque4Casa18')).toEqual(esperado);
    // El orden distinto se sigue admitiendo.
    expect(parseHomeReference('Casa 18, Bloque 4, Etapa 1')).toEqual(esperado);
  });

  it('H2 corregido: un pago NO_ENCONTRADO libera el mes y el siguiente lo toma', async () => {
    // Invariante 5: NO_ENCONTRADO, RECHAZADO y ANULADO liberan el mes.
    const notFound = base({ id: 'nf', status: 'NO_ENCONTRADO', period: '2026-09', reference: 'OLD1', fileHash: 'x' });
    const now = () => new Date('2026-09-20T12:00:00Z');
    const store = new MemoryPaymentStore({ homes, payments: [notFound] }, now);

    const r = await processReceiptMessage({ messageId: 'a', phone: '+504', bytes: png(1), declaredMime: 'image/png', syntheticOcrText: receipt('20/09/2026', 'NEWREF0001') }, { store, now });
    expect(r.status).toBe('PENDIENTE_VERIFICACION');

    const pago = (await store.listPayments()).find((item) => item.id !== 'nf');
    expect(pago?.period).toBe('2026-09');
  });

  it('H3 corregido: dos cuotas seguidas sin verificar caen en meses distintos', async () => {
    // Un pago pendiente reserva su mes, así que el segundo avanza en vez de chocar.
    const now = () => new Date('2026-10-02T12:00:00Z');
    const store = new MemoryPaymentStore({ homes }, now);

    const first = await processReceiptMessage({ messageId: 'a', phone: '+504', bytes: png(1), declaredMime: 'image/png', syntheticOcrText: receipt('01/09/2026', 'REFSEP0001') }, { store, now });
    const second = await processReceiptMessage({ messageId: 'b', phone: '+504', bytes: png(2), declaredMime: 'image/png', syntheticOcrText: receipt('01/10/2026', 'REFOCT0001') }, { store, now });

    expect(first.status).toBe('PENDIENTE_VERIFICACION');
    expect(second.status).toBe('PENDIENTE_VERIFICACION');

    const pagos = await store.listPayments();
    expect(pagos.map((pago) => pago.period).sort()).toEqual(['2026-09', '2026-10']);
  });

  it('H4 corregido: la asignación de mes respeta la fecha de alta de la vivienda', () => {
    // Casa dada de alta en noviembre: no debe septiembre ni octubre.
    const alta = { stage: '1', block: '4', house: '18', startDate: '2026-11-05' };
    expect(assignServicePeriod(alta, '2026-11-05', [])).toBe('2026-11');
    // Sin fecha de alta, arranca en el primer mes de servicio del sistema.
    expect(assignServicePeriod({ stage: '1', block: '4', house: '18' }, '2026-11-05', [])).toBe('2026-09');
  });

  it('H5 corregido: en producción, sin beneficiario configurado nada pasa como pago normal', async () => {
    // Invariante 4: beneficiario y cuenta destino son obligatorios en producción.
    process.env.APP_MODE = 'production';
    resetEnvForTests();
    const now = () => new Date('2026-09-08T12:00:00Z');
    const store = new MemoryPaymentStore({ homes }, now);
    const other = receipt('07/09/2026', 'REFOTRA001').replace('RESIDENCIAL DEMO', 'OTRA PERSONA').replace('000000000001', '999999999999');

    const r = await processReceiptMessage({ messageId: 'a', phone: '+504', bytes: png(1), declaredMime: 'image/png', syntheticOcrText: other }, { store, now });
    expect(r.status).toBe('EN_REVISION');
  });

  it('H5 corregido: un depósito a otra cuenta no se verifica', async () => {
    process.env.APP_MODE = 'production';
    process.env.EXPECTED_BENEFICIARY = 'RESIDENCIAL DEMO';
    process.env.EXPECTED_ACCOUNT_LAST4 = '0001';
    resetEnvForTests();
    const now = () => new Date('2026-09-08T12:00:00Z');
    const store = new MemoryPaymentStore({ homes }, now);
    const other = receipt('07/09/2026', 'REFOTRA003').replace('RESIDENCIAL DEMO', 'OTRA PERSONA').replace('000000000001', '999999999999');

    const r = await processReceiptMessage({ messageId: 'a', phone: '+504', bytes: png(1), declaredMime: 'image/png', syntheticOcrText: other }, { store, now });
    expect(r.status).toBe('EN_REVISION');
    expect(r.reason).toBe('beneficiary_unexpected');
  });

  it('H6 corregido: la comparación del beneficiario es exacta', async () => {
    // 'DEMO' ya no pasa como si fuera 'RESIDENCIAL DEMO'.
    process.env.EXPECTED_BENEFICIARY = 'RESIDENCIAL DEMO';
    resetEnvForTests();
    const now = () => new Date('2026-09-08T12:00:00Z');
    const store = new MemoryPaymentStore({ homes }, now);
    const other = receipt('07/09/2026', 'REFOTRA002').replace('RESIDENCIAL DEMO', 'DEMO');

    const r = await processReceiptMessage({ messageId: 'a', phone: '+504', bytes: png(1), declaredMime: 'image/png', syntheticOcrText: other }, { store, now });
    expect(r.status).toBe('EN_REVISION');
    expect(r.reason).toBe('beneficiary_unexpected');
  });

  it('H6 corregido: el nombre exacto sí pasa', async () => {
    process.env.EXPECTED_BENEFICIARY = 'RESIDENCIAL DEMO';
    resetEnvForTests();
    const now = () => new Date('2026-09-08T12:00:00Z');
    const store = new MemoryPaymentStore({ homes }, now);

    const r = await processReceiptMessage({ messageId: 'a', phone: '+504', bytes: png(1), declaredMime: 'image/png', syntheticOcrText: receipt('07/09/2026', 'REFOK000001') }, { store, now });
    expect(r.status).toBe('PENDIENTE_VERIFICACION');
  });

  it('H7 corregido: "Transacción exitosa" ya no se toma como referencia', () => {
    const text = SYNTHETIC_BAC_RECEIPTS.valid.replace('Transferencia realizada', 'Transacción exitosa');
    // Se queda con la etiqueta 'Referencia', que es la real.
    expect(bacParser.parse(text).reference).toBe('DEMOREF000001');
  });

  it('H8: un registro DUPLICADO reasignado a otra casa por el panel queda verificable', () => {
    // El endpoint assign-home no revisa el estado: pasa a PENDIENTE_VERIFICACION.
    const dup = base({ status: 'DUPLICADO', duplicateOf: 'orig' });
    const afterAssignHome = { ...dup, house: '19', status: 'PENDIENTE_VERIFICACION' as const };
    expect(canManuallyVerify(afterAssignHome)).toBe(true);
  });

  it('H9: un monto distinto de L150 no tiene salida (no se puede verificar y no hay acción de rechazo)', () => {
    const p = base({ amount: 300, status: 'EN_REVISION', reviewReason: 'amount_above_expected' });
    expect(canManuallyVerify(p, true)).toBe(false);
  });
});
