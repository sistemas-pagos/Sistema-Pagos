import { homeLabel } from '@/src/domain/housing';
import { homeKey, type DashboardSnapshot, type PaymentRecord } from '@/src/domain/types';
import { deriveMonthlyHomeStatus, isHomeActiveInPeriod } from '@/src/services/monthly-status';
import type { PaymentStore } from '@/src/storage/types';

const RECEIVED_STATUSES = new Set<PaymentRecord['status']>([
  'PENDIENTE_VERIFICACION', 'VERIFICADO', 'NO_ENCONTRADO', 'EN_REVISION', 'SIN_IDENTIFICAR', 'ESPERANDO_RESPUESTA',
]);

function isReceived(payment: PaymentRecord): boolean {
  return RECEIVED_STATUSES.has(payment.status) && payment.status !== 'DUPLICADO' && payment.status !== 'RECHAZADO';
}

function accountingPayments(payments: readonly PaymentRecord[]): PaymentRecord[] {
  return payments.filter((payment) => payment.status !== 'DUPLICADO' && payment.status !== 'RECHAZADO');
}

export async function buildDashboardSnapshot(store: PaymentStore, period: string): Promise<DashboardSnapshot> {
  const [allHomes, storedPayments] = await Promise.all([store.listHomes(), store.listPayments()]);
  const homes = allHomes.filter((home) => isHomeActiveInPeriod(home, period));
  const activeHomeKeys = new Set(homes.map(homeKey));
  const homesByKey = new Map(homes.map((home) => [homeKey(home), home]));
  const allPayments = storedPayments.filter((payment) => payment.period === period);
  const monthlyStatus = deriveMonthlyHomeStatus(homes, allPayments, period);
  const received = accountingPayments(allPayments).filter(isReceived);
  const assigned = received.filter((payment) => payment.stage != null && payment.block != null && payment.house != null);
  const assignedToActiveHomes = assigned.filter((payment) => activeHomeKeys.has(homeKey({ stage: payment.stage!, block: payment.block!, house: payment.house! })));
  const verifiedAssigned = assignedToActiveHomes.filter((payment) => payment.status === 'VERIFICADO');
  const paidRows = monthlyStatus.filter((row) => row.status === 'PAGADO');
  const verifyingRows = monthlyStatus.filter((row) => row.status === 'POR_VERIFICAR');
  const reviewRows = monthlyStatus.filter((row) => row.status === 'EN_REVISION');
  const pendingRows = monthlyStatus.filter((row) => row.status === 'PENDIENTE');
  const expectedAmount = monthlyStatus.reduce((total, row) => total + row.monthlyFee, 0);
  const receivedAmount = received.reduce((total, payment) => total + payment.amount, 0);
  const verifiedAmount = verifiedAssigned.reduce((total, payment) => total + payment.amount, 0);
  const pendingAmount = monthlyStatus
    .filter((row) => row.status !== 'PAGADO')
    .reduce((total, row) => total + row.monthlyFee, 0);
  const unidentifiedAmount = received
    .filter((payment) => payment.stage == null || payment.block == null || payment.house == null)
    .reduce((total, payment) => total + payment.amount, 0);

  const groups = new Map<string, { stage: number; block: number }>();
  monthlyStatus.forEach((row) => groups.set(`${row.stage}:${row.block}`, { stage: row.stage, block: row.block }));
  const blocks = Array.from(groups.values())
    .sort((a, b) => a.stage - b.stage || a.block - b.block)
    .map(({ stage, block }) => {
      const rows = monthlyStatus.filter((row) => row.stage === stage && row.block === block);
      const paidHomes = rows.filter((row) => row.status === 'PAGADO').length;
      const verifyingHomes = rows.filter((row) => row.status === 'POR_VERIFICAR').length;
      const reviewHomes = rows.filter((row) => row.status === 'EN_REVISION').length;
      const pendingHomes = rows.filter((row) => row.status === 'PENDIENTE').length;
      const collected = verifiedAssigned
        .filter((payment) => payment.stage === stage && payment.block === block)
        .reduce((total, payment) => total + payment.amount, 0);
      return {
        stage,
        block,
        totalHomes: rows.length,
        paidHomes,
        verifyingHomes,
        reviewHomes,
        pendingHomes,
        collected,
        collectionRate: rows.length ? paidHomes / rows.length : 0,
      };
    });

  const toRow = (payment: PaymentRecord) => {
    const ref = payment.stage != null && payment.block != null && payment.house != null
      ? { stage: payment.stage, block: payment.block, house: payment.house }
      : undefined;
    const monthlyFee = ref ? homesByKey.get(homeKey(ref))?.monthlyFee : undefined;
    return {
      ...payment,
      homeLabel: homeLabel(ref),
      monthlyFee,
    };
  };
  const sortNewest = (a: PaymentRecord, b: PaymentRecord) => b.createdAt.localeCompare(a.createdAt);

  return {
    period,
    totalHomes: monthlyStatus.length,
    paidHomes: paidRows.length,
    verifyingHomes: verifyingRows.length,
    reviewHomes: reviewRows.length,
    pendingHomes: pendingRows.length,
    collectionRate: monthlyStatus.length ? paidRows.length / monthlyStatus.length : 0,
    expectedAmount,
    receivedAmount,
    verifiedAmount,
    pendingAmount,
    unidentifiedAmount,
    blocks,
    monthlyStatus,
    payments: [...allPayments].sort(sortNewest).map(toRow),
    unidentified: allPayments.filter((payment) => payment.status === 'SIN_IDENTIFICAR' || payment.status === 'ESPERANDO_RESPUESTA').sort(sortNewest).map(toRow),
    duplicates: allPayments.filter((payment) => payment.status === 'DUPLICADO').sort(sortNewest).map(toRow),
    review: allPayments.filter((payment) => payment.status === 'EN_REVISION' || payment.status === 'NO_ENCONTRADO').sort(sortNewest).map(toRow),
  };
}
