import { describe, expect, it } from 'vitest';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { periodWindow, shiftPeriod } from '@/src/domain/periods';
import { buildHouseHistoryGrid, getHouseHistory } from '@/src/services/house-history';
import { MemoryPaymentStore } from '@/src/storage/memory';

const homes: HomeRecord[] = [
  { id: 'home-e1-4-18', stage: 1, block: 4, house: 18, monthlyFee: 150, active: true },
  { id: 'home-e1-4-19', stage: 1, block: 4, house: 19, monthlyFee: 150, active: true },
];

function payment(id: string, period: string, status: PaymentRecord['status'], house = 18): PaymentRecord {
  return {
    id, createdAt: `${period}-08T12:00:00.000Z`, updatedAt: `${period}-08T12:00:00.000Z`, sourceMessageId: `msg-${id}`,
    phone: '+50400000000', bank: 'BAC Honduras', amount: 150, stage: 1, block: 4, house,
    period, status, fileHash: `hash-${id}`,
  };
}

describe('house history', () => {
  it('builds deterministic monthly windows across year boundaries', () => {
    expect(shiftPeriod('2026-01', -1)).toBe('2025-12');
    expect(periodWindow('2026-09', 4)).toEqual(['2026-09', '2026-08', '2026-07', '2026-06']);
  });

  it('shows verified, received, review, and pending states per EBC home', async () => {
    const store = new MemoryPaymentStore({ homes, payments: [
      payment('sep', '2026-09', 'VERIFICADO'), payment('aug', '2026-08', 'PENDIENTE_VERIFICACION'), payment('jul', '2026-07', 'EN_REVISION'),
    ] });
    const grid = await buildHouseHistoryGrid(store, '2026-09', 4);
    const row = grid.rows.find((item) => item.home.house === 18);
    expect(row?.periods.map((cell) => cell.state)).toEqual(['VERIFICADO', 'RECIBIDO', 'EN_REVISION', 'PENDIENTE']);
    expect(grid.rows.find((item) => item.home.house === 19)?.periods.every((cell) => cell.state === 'PENDIENTE')).toBe(true);
  });

  it('returns a house payment history newest period first without hiding trace records', async () => {
    const store = new MemoryPaymentStore({ homes, payments: [
      payment('old', '2026-08', 'VERIFICADO'), payment('new', '2026-09', 'PENDIENTE_VERIFICACION'), payment('dup', '2026-09', 'DUPLICADO'),
    ] });
    const history = await getHouseHistory(store, 1, 4, 18);
    expect(history.home?.id).toBe('home-e1-4-18');
    expect(history.payments.map((item) => item.id)).toEqual(['new', 'dup', 'old']);
  });
});
