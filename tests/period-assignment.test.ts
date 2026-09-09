import { describe, expect, it } from 'vitest';
import type { PaymentRecord } from '@/src/domain/types';
import { assignServicePeriod, baselinePeriodFromDepositDate } from '@/src/services/period-assignment';

const home = { stage: 1, block: 4, house: 18 };

function payment(period: string, id = `pay-${period}`, status: PaymentRecord['status'] = 'VERIFICADO'): PaymentRecord {
  return {
    id, createdAt: `${period}-01T00:00:00.000Z`, updatedAt: `${period}-01T00:00:00.000Z`, sourceMessageId: `msg-${id}`,
    phone: '+50400000000', bank: 'BAC Honduras', amount: 150, stage: 1, block: 4, house: 18,
    period, status, fileHash: `hash-${id}`,
  };
}

describe('service month assignment', () => {
  it('treats August 1-14 as the previous month and August 15 onward as August', () => {
    expect(baselinePeriodFromDepositDate('2026-08-01')).toBe('2026-07');
    expect(baselinePeriodFromDepositDate('2026-08-14')).toBe('2026-07');
    expect(baselinePeriodFromDepositDate('2026-08-15')).toBe('2026-08');
    expect(baselinePeriodFromDepositDate('2026-08-31')).toBe('2026-08');
  });

  it('assigns a September deposit to August when August is still pending', () => {
    expect(assignServicePeriod(home, '2026-09-01', [])).toBe('2026-08');
  });

  it('does not advance because an August receipt is merely pending verification', () => {
    expect(assignServicePeriod(home, '2026-09-01', [payment('2026-08', 'pending-aug', 'PENDIENTE_VERIFICACION')])).toBe('2026-08');
  });

  it('assigns a September deposit to September once August is verified paid', () => {
    expect(assignServicePeriod(home, '2026-09-01', [payment('2026-08')])).toBe('2026-09');
  });

  it('walks forward from August to the oldest unpaid month using verified history', () => {
    expect(assignServicePeriod(home, '2026-11-20', [payment('2026-08'), payment('2026-09')])).toBe('2026-10');
  });

  it('does not silently advance beyond the deposit month when all months are verified', () => {
    expect(assignServicePeriod(home, '2026-09-20', [payment('2026-08'), payment('2026-09')])).toBe('2026-09');
  });
});
