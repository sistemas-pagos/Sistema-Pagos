import { compareHomeParts, homeLabel } from '@/src/domain/housing';
import { homeKey, type DashboardSnapshot, type PaymentRecord } from '@/src/domain/types';
import { deriveMonthlyHomeStatus, isHomeActiveInPeriod } from '@/src/services/monthly-status';
import { mesesDelPago } from '@/src/services/period-assignment';
import type { PaymentStore } from '@/src/storage/types';

const RECEIVED_STATUSES = new Set<PaymentRecord['status']>([
  'PENDIENTE_VERIFICACION', 'VERIFICADO', 'EFECTIVO_COBRADO', 'NO_ENCONTRADO', 'EN_REVISION', 'ESPERANDO_RESPUESTA',
]);

function isReceived(payment: PaymentRecord): boolean {
  return RECEIVED_STATUSES.has(payment.status) && payment.status !== 'DUPLICADO' && payment.status !== 'RECHAZADO';
}

/** Una casa que todavia no existia en ese mes no se cuenta ni como inactiva. */
function existeEnElPeriodo(home: { startDate?: string }, period: string): boolean {
  return !home.startDate || home.startDate.slice(0, 7) <= period;
}

function accountingPayments(payments: readonly PaymentRecord[]): PaymentRecord[] {
  return payments.filter((payment) => payment.status !== 'DUPLICADO' && payment.status !== 'RECHAZADO');
}

export async function buildDashboardSnapshot(store: PaymentStore, period: string): Promise<DashboardSnapshot> {
  const [allHomes, storedPayments] = await Promise.all([store.listHomes(), store.listPayments()]);
  const homes = allHomes.filter((home) => isHomeActiveInPeriod(home, period));
  // Las que no pagan el servicio se cuentan aparte y no entran en nada mas: ni
  // en el total de viviendas, ni en lo esperado, ni en lo pendiente. Se miran
  // solo las que ya existian en el periodo, para no contar una casa dada de
  // alta despues.
  const inactiveHomes = allHomes.filter(
    (home) => !isHomeActiveInPeriod(home, period) && existeEnElPeriodo(home, period),
  ).length;
  const activeHomeKeys = new Set(homes.map(homeKey));
  const homesByKey = new Map(homes.map((home) => [homeKey(home), home]));
  const allPayments = storedPayments.filter((payment) => mesesDelPago(payment).includes(period));
  const monthlyStatus = deriveMonthlyHomeStatus(homes, allPayments, period);

  // Mientras la casa esta inactiva, su plata no suma en ningun total.
  //
  // No es que ese pago no exista: esta en la bandeja de revision, con nombre y
  // monto, esperando que el admin decida. Lo que no puede hacer es engordar el
  // recaudado de un mes en el que esa casa no estaba cobrando. En cuanto el
  // admin la activa, la casa entra en `homes` y su pago empieza a sumar solo,
  // sin tocar nada aca: de ahi en adelante es una casa activa como cualquiera.
  //
  // Se mira el padron, no `activeHomeKeys`: una vivienda que **no esta** en el
  // padron es otro problema —y su plata si tiene que verse.
  const inactiveHomeKeys = new Set(
    allHomes.filter((home) => !isHomeActiveInPeriod(home, period)).map(homeKey),
  );
  const deCasaInactiva = (payment: PaymentRecord): boolean =>
    payment.stage != null && payment.block != null && payment.house != null
    && inactiveHomeKeys.has(homeKey({ stage: payment.stage, block: payment.block, house: payment.house }));

  const received = accountingPayments(allPayments).filter(isReceived).filter((pago) => !deCasaInactiva(pago));
  const assigned = received.filter((payment) => payment.stage != null && payment.block != null && payment.house != null);
  const assignedToActiveHomes = assigned.filter((payment) => activeHomeKeys.has(homeKey({ stage: payment.stage!, block: payment.block!, house: payment.house! })));
  const verifiedAssigned = assignedToActiveHomes.filter((payment) => payment.status === 'VERIFICADO' || payment.status === 'EFECTIVO_COBRADO');
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

  const groups = new Map<string, { stage: string; block: string }>();
  monthlyStatus.forEach((row) => groups.set(`${row.stage}:${row.block}`, { stage: row.stage, block: row.block }));
  const blocks = Array.from(groups.values())
    .sort((a, b) => compareHomeParts(a.stage, b.stage) || compareHomeParts(a.block, b.block))
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
    inactiveHomes,
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
    unidentified: allPayments.filter((payment) => payment.status === 'ESPERANDO_RESPUESTA').sort(sortNewest).map(toRow),
    duplicates: allPayments.filter((payment) => payment.status === 'DUPLICADO').sort(sortNewest).map(toRow),
    review: allPayments.filter((payment) => payment.status === 'EN_REVISION' || payment.status === 'NO_ENCONTRADO').sort(sortNewest).map(toRow),
  };
}
