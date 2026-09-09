import { describe, expect, it } from 'vitest';
import { decideDuplicate } from '@/src/domain/duplicates';
import type { PaymentRecord } from '@/src/domain/types';

const existing: PaymentRecord = {
  id: 'pay-1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceMessageId: 'msg-1', phone: '+50400000001',
  bank: 'BAC Honduras', amount: 150, transactionDate: '2026-09-01', reference: 'REF000001', stage: 1, block: 4, house: 18, period: '2026-09', status: 'PENDIENTE_VERIFICACION', fileHash: 'hash-1',
};

describe('duplicate policy', () => {
  it('treats the same WhatsApp message id as a technical retry', () => {
    expect(decideDuplicate({ sourceMessageId: 'msg-1', fileHash: 'new', bank: 'BAC Honduras' }, [existing]).kind).toBe('retry');
  });

  it('detects an exact file resend', () => {
    expect(decideDuplicate({ sourceMessageId: 'msg-2', fileHash: 'hash-1', bank: 'BAC Honduras' }, [existing]).kind).toBe('duplicate');
  });

  it('sends a repeated reference for another EBC home to conflict review', () => {
    const result = decideDuplicate({ sourceMessageId: 'msg-3', fileHash: 'new', bank: 'BAC Honduras', reference: 'REF000001', home: { stage: 1, block: 2, house: 2 } }, [existing]);
    expect(result.kind).toBe('conflict');
    expect(result.kind === 'conflict' && result.reason).toBe('bank_reference_home_conflict');
  });

  it('does not auto-deduplicate a repeated reference even when data match', () => {
    const result = decideDuplicate({
      sourceMessageId: 'msg-3b', fileHash: 'new', bank: 'BAC Honduras', reference: 'REF000001', amount: 150,
      transactionDate: '2026-09-01', home: { stage: 1, block: 4, house: 18 },
    }, [existing]);
    expect(result.kind).toBe('review');
    expect(result.kind === 'review' && result.reason).toBe('bank_reference_reused');
  });

  it('flags a repeated reference with conflicting amount or date', () => {
    const result = decideDuplicate({
      sourceMessageId: 'msg-3c', fileHash: 'new', bank: 'BAC Honduras', reference: 'REF000001', amount: 175,
      transactionDate: '2026-09-02', home: { stage: 1, block: 4, house: 18 },
    }, [existing]);
    expect(result.kind).toBe('conflict');
    expect(result.kind === 'conflict' && result.reason).toBe('bank_reference_data_conflict');
  });

  it('does not auto-deduplicate a weak amount/date match', () => {
    const result = decideDuplicate({
      sourceMessageId: 'msg-4', fileHash: 'new', bank: 'BAC Honduras', amount: 150,
      transactionDate: '2026-09-01', home: { stage: 1, block: 4, house: 18 },
    }, [existing]);
    expect(result.kind).toBe('review');
  });
});
