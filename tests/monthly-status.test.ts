import { describe, expect, it } from 'vitest';
import type { HomeRecord, PaymentRecord, PaymentStatus } from '@/src/domain/types';
import { deriveMonthlyHomeStatus } from '@/src/services/monthly-status';

const PERIOD = '2026-09';

function home(house: number, extra: Partial<HomeRecord> = {}): HomeRecord {
  return { id: `home-${house}`, stage: 1, block: 1, house, monthlyFee: 150, active: true, ...extra };
}

function payment(id: string, house: number, status: PaymentStatus, amount = 150): PaymentRecord {
  return {
    id,
    createdAt: `2026-09-0${house}T10:00:00.000Z`,
    updatedAt: `2026-09-0${house}T10:00:00.000Z`,
    sourceMessageId: `msg-${id}`,
    phone: '+50400000000',
    bank: 'BAC Honduras',
    transactionDate: `2026-09-0${house}`,
    amount,
    stage: 1,
    block: 1,
    house,
    period: PERIOD,
    status,
    fileHash: `hash-${id}`,
  };
}

describe('monthly home status', () => {
  it('derives PAGADO, POR_VERIFICAR, EN_REVISION and PENDIENTE from homes + payments', () => {
    const homes = [home(1), home(2), home(3), home(4)];
    const payments: PaymentRecord[] = [
      payment('verified', 1, 'VERIFICADO'),
      payment('waiting', 2, 'PENDIENTE_VERIFICACION'),
      { ...payment('review', 3, 'EN_REVISION', 175), reviewReason: 'amount_above_expected' },
    ];

    const rows = deriveMonthlyHomeStatus(homes, payments, PERIOD);
    expect(rows.map((row) => row.status)).toEqual(['PAGADO', 'POR_VERIFICAR', 'EN_REVISION', 'PENDIENTE']);
    expect(rows[0]?.paymentId).toBe('verified');
    expect(rows[1]?.receivedAmount).toBe(150);
    expect(rows[2]?.receivedAmount).toBe(175);
    expect(rows[3]?.paymentCount).toBe(0);
  });

  it('ignores duplicate and rejected receipts when deriving monthly collection state', () => {
    const rows = deriveMonthlyHomeStatus(
      [home(1)],
      [
        payment('waiting', 1, 'PENDIENTE_VERIFICACION'),
        { ...payment('duplicate', 1, 'DUPLICADO'), duplicateOf: 'waiting', duplicateReason: 'file_hash' },
        payment('rejected', 1, 'RECHAZADO'),
      ],
      PERIOD,
    );

    expect(rows[0]?.status).toBe('POR_VERIFICAR');
    expect(rows[0]?.paymentCount).toBe(1);
    expect(rows[0]?.receivedAmount).toBe(150);
  });

  it('keeps a verified obligation paid even when another receipt for the same month needs review', () => {
    const rows = deriveMonthlyHomeStatus(
      [home(1)],
      [
        payment('verified', 1, 'VERIFICADO'),
        { ...payment('extra', 1, 'EN_REVISION', 175), reviewReason: 'service_period_already_has_payment' },
      ],
      PERIOD,
    );

    expect(rows[0]?.status).toBe('PAGADO');
    expect(rows[0]?.paymentId).toBe('verified');
    expect(rows[0]?.paymentCount).toBe(2);
    expect(rows[0]?.receivedAmount).toBe(325);
  });

  it('only creates rows for homes that were active in the selected period', () => {
    const homes = [
      home(1),
      home(2, { active: false, startDate: '2026-01-01', endDate: '2026-08-20' }),
    ];

    expect(deriveMonthlyHomeStatus(homes, [], '2026-08')).toHaveLength(2);
    expect(deriveMonthlyHomeStatus(homes, [], '2026-09')).toHaveLength(1);
  });
});
