import { describe, expect, it } from 'vitest';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { HOME_HEADERS, PAYMENT_HEADERS, homeFromRow, homeToRow, paymentFromRow, paymentToRow } from '@/src/storage/sheets-schema';

const payment: PaymentRecord = {
  id: 'pay-demo', createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z', sourceMessageId: 'msg-demo',
  phone: '50400000001', bank: 'BAC Honduras', amount: 150, reference: 'DEMOREF000001', stage: 1, block: 4, house: 18,
  period: '2026-09', status: 'DUPLICADO', fileHash: 'hash-demo', duplicateOf: 'pay-original', duplicateReason: 'file_hash', bankMovementId: 'mov-demo-001',
};

const home: HomeRecord = { id: 'home-e1-b4-c18', stage: 1, block: 4, house: 18, monthlyFee: 150, active: true };

describe('Google Sheets schema', () => {
  it('round-trips payment stage, duplicate trace and bank movement fields without receipt media pointers', () => {
    const row = paymentToRow(payment);
    expect(row).toHaveLength(PAYMENT_HEADERS.length);
    expect(PAYMENT_HEADERS).not.toContain('media_id');
    expect(PAYMENT_HEADERS).not.toContain('receipt_file_id');
    expect(PAYMENT_HEADERS[14]).toBe('stage');
    expect(PAYMENT_HEADERS[21]).toBe('duplicate_reason');
    expect(PAYMENT_HEADERS[25]).toBe('bank_movement_id');
    expect(paymentFromRow(row)).toMatchObject({
      id: payment.id, stage: 1, block: 4, house: 18, status: 'DUPLICADO', duplicateOf: 'pay-original', duplicateReason: 'file_hash', bankMovementId: 'mov-demo-001',
    });
  });

  it('stores no housing phone column and round-trips EBC identity', () => {
    expect(HOME_HEADERS).toEqual(['id', 'stage', 'block', 'house', 'responsible', 'monthly_fee', 'active', 'start_date', 'end_date']);
    expect(homeFromRow(homeToRow(home))).toMatchObject(home);
  });
});
