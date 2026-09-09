import type { HomeRecord, MonthlyCollectionStatus, MonthlyHomeStatusRow, PaymentRecord } from '@/src/domain/types';
import type { PaymentStore } from '@/src/storage/types';

const COUNTABLE_PAYMENT_STATUSES = new Set<PaymentRecord['status']>([
  'COMPROBANTE_RECIBIDO',
  'PROCESANDO',
  'EXTRAIDO',
  'PENDIENTE_VERIFICACION',
  'VERIFICADO',
  'NO_ENCONTRADO',
  'EN_REVISION',
]);

export function isHomeActiveInPeriod(home: HomeRecord, period: string): boolean {
  const monthStart = `${period}-01`;
  const monthEnd = `${period}-31`;
  if (home.startDate && home.startDate > monthEnd) return false;
  if (home.endDate && home.endDate < monthStart) return false;
  return home.active || Boolean(home.endDate && home.endDate >= monthStart);
}

function assignedToHome(payment: PaymentRecord, home: HomeRecord, period: string): boolean {
  return payment.period === period
    && payment.stage === home.stage
    && payment.block === home.block
    && payment.house === home.house;
}

function usablePayments(payments: readonly PaymentRecord[], home: HomeRecord, period: string): PaymentRecord[] {
  return payments
    .filter((payment) => assignedToHome(payment, home, period))
    .filter((payment) => COUNTABLE_PAYMENT_STATUSES.has(payment.status));
}

function classify(payments: readonly PaymentRecord[]): MonthlyCollectionStatus {
  if (payments.some((payment) => payment.status === 'VERIFICADO')) return 'PAGADO';
  if (payments.some((payment) => payment.status === 'EN_REVISION' || payment.status === 'NO_ENCONTRADO')) return 'EN_REVISION';
  if (payments.length > 0) return 'POR_VERIFICAR';
  return 'PENDIENTE';
}

function representativeRank(payment: PaymentRecord): number {
  if (payment.status === 'VERIFICADO') return 3;
  if (payment.status === 'EN_REVISION' || payment.status === 'NO_ENCONTRADO') return 2;
  return 1;
}

function representative(payments: readonly PaymentRecord[]): PaymentRecord | undefined {
  return [...payments].sort((a, b) =>
    representativeRank(b) - representativeRank(a)
    || b.updatedAt.localeCompare(a.updatedAt)
    || b.createdAt.localeCompare(a.createdAt),
  )[0];
}

export function deriveMonthlyHomeStatus(
  homes: readonly HomeRecord[],
  payments: readonly PaymentRecord[],
  period: string,
): MonthlyHomeStatusRow[] {
  return homes
    .filter((home) => isHomeActiveInPeriod(home, period))
    .sort((a, b) => a.stage - b.stage || a.block - b.block || a.house - b.house)
    .map((home) => {
      const matches = usablePayments(payments, home, period);
      const selected = representative(matches);
      return {
        period,
        homeId: home.id,
        stage: home.stage,
        block: home.block,
        house: home.house,
        monthlyFee: home.monthlyFee,
        status: classify(matches),
        receivedAmount: matches.reduce((total, payment) => total + payment.amount, 0),
        paymentCount: matches.length,
        paymentId: selected?.id,
        paymentDate: selected?.transactionDate ?? selected?.createdAt.slice(0, 10),
      };
    });
}

export async function buildMonthlyHomeStatus(store: PaymentStore, period: string): Promise<MonthlyHomeStatusRow[]> {
  const [homes, payments] = await Promise.all([store.listHomes(), store.listPayments()]);
  return deriveMonthlyHomeStatus(homes, payments, period);
}
