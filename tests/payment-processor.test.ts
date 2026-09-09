import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { SYNTHETIC_BAC_RECEIPTS } from '@/src/demo/data';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { processHomeReply, processReceiptMessage } from '@/src/services/payment-processor';
import { MemoryPaymentStore } from '@/src/storage/memory';

const homes: HomeRecord[] = [
  { id: 'home-e1-b4-c18', stage: 1, block: 4, house: 18, monthlyFee: 150, active: true },
  { id: 'home-e1-b2-c2', stage: 1, block: 2, house: 2, monthlyFee: 150, active: true },
];

function png(variant: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, variant]);
}

const now = () => new Date('2026-09-08T18:00:00.000Z');

beforeEach(() => {
  process.env.APP_MODE = 'demo';
  delete process.env.EXPECTED_PAYMENT_AMOUNT;
  delete process.env.EXPECTED_BENEFICIARY;
  delete process.env.EXPECTED_ACCOUNT_LAST4;
  resetEnvForTests();
});

afterEach(() => {
  delete process.env.APP_MODE;
  delete process.env.EXPECTED_PAYMENT_AMOUNT;
  delete process.env.EXPECTED_BENEFICIARY;
  delete process.env.EXPECTED_ACCOUNT_LAST4;
  resetEnvForTests();
});

describe('payment processor', () => {
  it('registers a valid BAC receipt and assigns August when it is the first pending month', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const result = await processReceiptMessage({
      messageId: 'msg-valid', phone: '+50400000999', bytes: png(1), declaredMime: 'image/png', syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.valid,
    }, { store, now });

    expect(result.action).toBe('reply');
    expect(result.status).toBe('PENDIENTE_VERIFICACION');
    const payment = (await store.listPayments())[0];
    expect(payment.stage).toBe(1);
    expect(payment.block).toBe(4);
    expect(payment.house).toBe(18);
    expect(payment.period).toBe('2026-08');
    expect(payment.status).not.toBe('VERIFICADO');
  });

  it('uses September when August already has a verified payment for the same EBC home', async () => {
    const august: PaymentRecord = {
      id: 'pay-aug', createdAt: '2026-08-31T12:00:00.000Z', updatedAt: '2026-08-31T12:00:00.000Z', sourceMessageId: 'old-msg',
      phone: '+50400000111', bank: 'BAC Honduras', amount: 150, transactionDate: '2026-08-31', reference: 'OLDREF001',
      stage: 1, block: 4, house: 18, period: '2026-08', status: 'VERIFICADO', fileHash: 'old-hash',
    };
    const store = new MemoryPaymentStore({ homes, payments: [august] }, now);
    const result = await processReceiptMessage({
      messageId: 'msg-september', phone: '+50400000999', bytes: png(7), declaredMime: 'image/png', syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.valid,
    }, { store, now });
    expect(result.status).toBe('PENDIENTE_VERIFICACION');
    const payment = (await store.listPayments()).find((item) => item.id !== 'pay-aug');
    expect(payment?.period).toBe('2026-09');
  });

  it('keeps a second receipt on August and sends it to review when the first August receipt is still unverified', async () => {
    const augustPending: PaymentRecord = {
      id: 'pay-aug-pending', createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z', sourceMessageId: 'old-pending-msg',
      phone: '+50400000111', bank: 'BAC Honduras', amount: 150, transactionDate: '2026-09-01', reference: 'OLDPENDING001',
      stage: 1, block: 4, house: 18, period: '2026-08', status: 'PENDIENTE_VERIFICACION', fileHash: 'old-pending-hash',
    };
    const store = new MemoryPaymentStore({ homes, payments: [augustPending] }, now);
    const result = await processReceiptMessage({
      messageId: 'msg-second-august', phone: '+50400000999', bytes: png(10), declaredMime: 'image/png', syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.valid,
    }, { store, now });
    expect(result.status).toBe('EN_REVISION');
    const payment = (await store.listPayments()).find((item) => item.id !== 'pay-aug-pending');
    expect(payment?.period).toBe('2026-08');
    expect(payment?.reviewReason).toBe('service_period_already_has_payment');
  });

  it('asks for all EBC values, preserves context, and assigns without rerunning OCR', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const received = await processReceiptMessage({
      messageId: 'msg-missing-home', phone: '+50400000999', bytes: png(2), declaredMime: 'image/png', syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.missingHome,
    }, { store, now });

    expect(received.status).toBe('ESPERANDO_RESPUESTA');
    expect(received.reply).toContain('Ejemplo: E1 B4 C18');
    expect(await store.getPendingByPhone('+50400000999')).toBeDefined();

    const incomplete = await processHomeReply('msg-incomplete', '+50400000999', 'B4 C18', { store, now });
    expect(incomplete.reason).toBe('invalid_home_reply');

    const assigned = await processHomeReply('msg-home-reply', '+50400000999', 'E1 B4 C18', { store, now });
    expect(assigned.status).toBe('PENDIENTE_VERIFICACION');
    const payment = await store.getPayment(received.paymentId!);
    expect(payment?.stage).toBe(1);
    expect(payment?.block).toBe(4);
    expect(payment?.house).toBe(18);
    expect(payment?.period).toBe('2026-08');
    expect(await store.getPendingByPhone('+50400000999')).toBeUndefined();
  });

  it('ignores a Meta retry silently and detects an exact user resend as duplicate', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const input = { messageId: 'msg-original', phone: '+50400000010', bytes: png(3), declaredMime: 'image/png', syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.valid } as const;
    await processReceiptMessage(input, { store, now });

    const retry = await processReceiptMessage(input, { store, now });
    expect(retry.action).toBe('silent');
    expect(retry.reason).toBe('technical_retry');

    const resend = await processReceiptMessage({ ...input, messageId: 'msg-resend' }, { store, now });
    expect(resend.status).toBe('DUPLICADO');
    expect(resend.reply).toContain('No se registró un segundo pago');
  });

  it('sends a suspicious destination account to review instead of verifying it', async () => {
    process.env.EXPECTED_ACCOUNT_LAST4 = '9999';
    resetEnvForTests();
    const store = new MemoryPaymentStore({ homes }, now);
    const result = await processReceiptMessage({
      messageId: 'msg-review', phone: '+50400000010', bytes: png(4), declaredMime: 'image/png', syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.valid,
    }, { store, now });
    expect(result.status).toBe('EN_REVISION');
    expect((await store.listPayments())[0].reviewReason).toBe('destination_account_unexpected');
  });

  it('sends any amount below or above L150 to human review', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const below = SYNTHETIC_BAC_RECEIPTS.valid
      .replace('L150.00', 'L149.00')
      .replace('DEMOREF000001', 'DEMOREF000149');
    const above = SYNTHETIC_BAC_RECEIPTS.valid
      .replace('L150.00', 'L151.00')
      .replace('DEMOREF000001', 'DEMOREF000151');

    const belowResult = await processReceiptMessage({
      messageId: 'msg-amount-below', phone: '+50400000020', bytes: png(8), declaredMime: 'image/png', syntheticOcrText: below,
    }, { store, now });
    const aboveResult = await processReceiptMessage({
      messageId: 'msg-amount-above', phone: '+50400000021', bytes: png(9), declaredMime: 'image/png', syntheticOcrText: above,
    }, { store, now });

    expect(belowResult.status).toBe('EN_REVISION');
    expect(aboveResult.status).toBe('EN_REVISION');
    const payments = await store.listPayments();
    expect(payments.find((item) => item.sourceMessageId === 'msg-amount-below')?.reviewReason).toBe('amount_below_expected');
    expect(payments.find((item) => item.sourceMessageId === 'msg-amount-above')?.reviewReason).toBe('amount_above_expected');
  });

  it('does not create a second ambiguous pending context for the same WhatsApp sender', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await processReceiptMessage({
      messageId: 'msg-pending-1', phone: '+50400000999', bytes: png(5), declaredMime: 'image/png', syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.missingHome,
    }, { store, now });
    const secondText = SYNTHETIC_BAC_RECEIPTS.missingHome.replace('DEMOREF000002', 'DEMOREF000099');
    const second = await processReceiptMessage({
      messageId: 'msg-pending-2', phone: '+50400000999', bytes: png(6), declaredMime: 'image/png', syntheticOcrText: secondText,
    }, { store, now });
    expect(second.status).toBe('EN_REVISION');
    expect(second.reason).toBe('pending_context_conflict');
  });
});
