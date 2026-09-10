import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import type { PaymentRecord } from '@/src/domain/types';
import { reconcilePendingPayments } from '@/src/services/reconciliation';
import { MemoryPaymentStore } from '@/src/storage/memory';

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1', createdAt: '2026-09-08T10:00:00.000Z', updatedAt: '2026-09-08T10:00:00.000Z', sourceMessageId: 'msg-1', phone: '+50400000001',
    bank: 'BAC Honduras', amount: 150, transactionDate: '2026-09-08', reference: 'BANKREF001', stage: 1, block: 4, house: 18,
    period: '2026-09', status: 'PENDIENTE_VERIFICACION', fileHash: 'hash-1', ...overrides,
  };
}

beforeEach(() => {
  delete process.env.EXPECTED_PAYMENT_AMOUNT;
  resetEnvForTests();
});

describe('bank reconciliation', () => {
  it('verifies only an exact bank + reference + amount match with a stable movement id', async () => {
    const store = new MemoryPaymentStore({ payments: [payment()] });
    const result = await reconcilePendingPayments(store, [{ id: 'mov-1', bank: 'BAC Honduras', reference: 'BANKREF001', amount: 150, transactionDate: '2026-09-08' }], 'synthetic-bank-file', new Date('2026-09-08T12:00:00.000Z'));
    expect(result.verified).toBe(1);
    const updated = await store.getPayment('pay-1');
    expect(updated?.status).toBe('VERIFICADO');
    expect(updated?.verificationSource).toBe('synthetic-bank-file');
    expect(updated?.bankMovementId).toBe('mov-1');
  });

  it('marks a missing bank movement as not found', async () => {
    const store = new MemoryPaymentStore({ payments: [payment()] });
    const result = await reconcilePendingPayments(store, [], 'synthetic-bank-file');
    expect(result.notFound).toBe(1);
    expect((await store.getPayment('pay-1'))?.status).toBe('NO_ENCONTRADO');
  });

  it('does not verify a date-conflicting transaction', async () => {
    const store = new MemoryPaymentStore({ payments: [payment()] });
    await reconcilePendingPayments(store, [{ id: 'mov-1', bank: 'BAC Honduras', reference: 'BANKREF001', amount: 150, transactionDate: '2026-09-07' }], 'synthetic-bank-file');
    expect((await store.getPayment('pay-1'))?.status).toBe('EN_REVISION');
    expect((await store.getPayment('pay-1'))?.reviewReason).toBe('reconciliation_date_conflict');
  });

  it('refuses automatic verification when the bank-side source has no stable movement id', async () => {
    const store = new MemoryPaymentStore({ payments: [payment()] });
    const result = await reconcilePendingPayments(store, [{ bank: 'BAC Honduras', reference: 'BANKREF001', amount: 150, transactionDate: '2026-09-08' }], 'synthetic-bank-file');
    expect(result.review).toBe(1);
    expect((await store.getPayment('pay-1'))?.reviewReason).toBe('bank_movement_id_missing');
  });

  it('never lets one bank movement verify two payment records in the same run', async () => {
    const store = new MemoryPaymentStore({ payments: [
      payment({ id: 'pay-1', sourceMessageId: 'msg-1', fileHash: 'hash-1', stage: 1, block: 4, house: 18 }),
      payment({ id: 'pay-2', sourceMessageId: 'msg-2', fileHash: 'hash-2', stage: 1, block: 4, house: 19 }),
    ] });
    const result = await reconcilePendingPayments(store, [{ id: 'mov-1', bank: 'BAC Honduras', reference: 'BANKREF001', amount: 150, transactionDate: '2026-09-08' }], 'synthetic-bank-file');
    expect(result.verified).toBe(0);
    expect(result.review).toBe(2);
    expect((await store.getPayment('pay-1'))?.reviewReason).toBe('reconciliation_movement_claimed_multiple_times');
    expect((await store.getPayment('pay-2'))?.reviewReason).toBe('reconciliation_movement_claimed_multiple_times');
  });

  it('does not reuse a movement already persisted on a verified payment in a later run', async () => {
    const alreadyVerified = payment({
      id: 'pay-old', sourceMessageId: 'msg-old', fileHash: 'hash-old', status: 'VERIFICADO', bankMovementId: 'mov-1', period: '2026-08',
    });
    const pending = payment({ id: 'pay-new', sourceMessageId: 'msg-new', fileHash: 'hash-new' });
    const store = new MemoryPaymentStore({ payments: [alreadyVerified, pending] });
    const result = await reconcilePendingPayments(store, [{ id: 'mov-1', bank: 'BAC Honduras', reference: 'BANKREF001', amount: 150, transactionDate: '2026-09-08' }], 'synthetic-bank-file');
    expect(result.verified).toBe(0);
    expect(result.review).toBe(1);
    expect((await store.getPayment('pay-new'))?.reviewReason).toBe('bank_movement_already_used');
    expect((await store.getPayment('pay-old'))?.status).toBe('VERIFICADO');
  });

  it('refuses automatic verification when another receipt is assigned to the same home and service month', async () => {
    const first = payment({ id: 'pay-1', sourceMessageId: 'msg-1', fileHash: 'hash-1', reference: 'BANKREF001' });
    const second = payment({ id: 'pay-2', sourceMessageId: 'msg-2', fileHash: 'hash-2', reference: 'BANKREF002' });
    const store = new MemoryPaymentStore({ payments: [first, second] });
    const result = await reconcilePendingPayments(store, [
      { id: 'mov-1', bank: 'BAC Honduras', reference: 'BANKREF001', amount: 150, transactionDate: '2026-09-08' },
      { id: 'mov-2', bank: 'BAC Honduras', reference: 'BANKREF002', amount: 150, transactionDate: '2026-09-08' },
    ], 'synthetic-bank-file');
    expect(result.verified).toBe(0);
    expect(result.review).toBe(2);
    expect((await store.getPayment('pay-1'))?.reviewReason).toBe('service_period_already_has_payment');
    expect((await store.getPayment('pay-2'))?.reviewReason).toBe('service_period_already_has_payment');
  });

  it('rechecks the actual amount before automatic verification even if status is pending', async () => {
    const store = new MemoryPaymentStore({ payments: [payment({ amount: 175 })] });
    const result = await reconcilePendingPayments(store, [{ id: 'mov-1', bank: 'BAC Honduras', reference: 'BANKREF001', amount: 175, transactionDate: '2026-09-08' }], 'synthetic-bank-file');
    expect(result.verified).toBe(0);
    expect(result.review).toBe(1);
    expect((await store.getPayment('pay-1'))?.reviewReason).toBe('amount_above_expected');
  });

  it('refuses automatic verification for an unidentified home even if bank data matches', async () => {
    const store = new MemoryPaymentStore({ payments: [payment({ stage: undefined })] });
    const result = await reconcilePendingPayments(store, [{ id: 'mov-1', bank: 'BAC Honduras', reference: 'BANKREF001', amount: 150, transactionDate: '2026-09-08' }], 'synthetic-bank-file');
    expect(result.verified).toBe(0);
    expect(result.review).toBe(1);
    expect((await store.getPayment('pay-1'))?.reviewReason).toBe('home_missing_for_reconciliation');
  });
});
