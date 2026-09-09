import { periodWindow } from '@/src/domain/periods';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import type { PaymentStore } from '@/src/storage/types';

export type HousePeriodState = 'VERIFICADO' | 'RECIBIDO' | 'EN_REVISION' | 'NO_ENCONTRADO' | 'PENDIENTE';

export interface HousePeriodCell {
  period: string;
  state: HousePeriodState;
  paymentId?: string;
  amount?: number;
}

export interface HouseHistoryRow {
  home: HomeRecord;
  periods: HousePeriodCell[];
}

function activeInPeriod(home: HomeRecord, period: string): boolean {
  const monthStart = `${period}-01`;
  const monthEnd = `${period}-31`;
  if (home.startDate && home.startDate > monthEnd) return false;
  if (home.endDate && home.endDate < monthStart) return false;
  return home.active || Boolean(home.endDate && home.endDate >= monthStart);
}

function usablePayments(payments: readonly PaymentRecord[], home: HomeRecord, period: string): PaymentRecord[] {
  return payments
    .filter((payment) => payment.period === period && payment.stage === home.stage && payment.block === home.block && payment.house === home.house)
    .filter((payment) => payment.status !== 'DUPLICADO' && payment.status !== 'RECHAZADO')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}

function classify(payments: readonly PaymentRecord[]): HousePeriodCell['state'] {
  if (payments.some((payment) => payment.status === 'VERIFICADO')) return 'VERIFICADO';
  if (payments.some((payment) => payment.status === 'PENDIENTE_VERIFICACION')) return 'RECIBIDO';
  if (payments.some((payment) => payment.status === 'EN_REVISION')) return 'EN_REVISION';
  if (payments.some((payment) => payment.status === 'NO_ENCONTRADO')) return 'NO_ENCONTRADO';
  if (payments.some((payment) => ['COMPROBANTE_RECIBIDO', 'PROCESANDO', 'EXTRAIDO'].includes(payment.status))) return 'RECIBIDO';
  return 'PENDIENTE';
}

export async function buildHouseHistoryGrid(store: PaymentStore, anchorPeriod: string, count = 4): Promise<{ periods: string[]; rows: HouseHistoryRow[] }> {
  const periods = periodWindow(anchorPeriod, count);
  const [homes, payments] = await Promise.all([store.listHomes(), store.listPayments()]);
  const rows = homes
    .filter((home) => periods.some((period) => activeInPeriod(home, period)))
    .sort((a, b) => a.stage - b.stage || a.block - b.block || a.house - b.house)
    .map((home) => ({
      home,
      periods: periods.map((period) => {
        if (!activeInPeriod(home, period)) return { period, state: 'PENDIENTE' as const };
        const matches = usablePayments(payments, home, period);
        const representative = matches[0];
        return {
          period,
          state: classify(matches),
          paymentId: representative?.id,
          amount: representative?.amount,
        };
      }),
    }));
  return { periods, rows };
}

export async function getHouseHistory(store: PaymentStore, stage: number, block: number, house: number): Promise<{ home?: HomeRecord; payments: PaymentRecord[] }> {
  const [homes, payments] = await Promise.all([store.listHomes(), store.listPayments()]);
  const home = homes.find((candidate) => candidate.stage === stage && candidate.block === block && candidate.house === house);
  const history = payments
    .filter((payment) => payment.stage === stage && payment.block === block && payment.house === house)
    .sort((a, b) => b.period.localeCompare(a.period) || b.createdAt.localeCompare(a.createdAt));
  return { home, payments: history };
}
