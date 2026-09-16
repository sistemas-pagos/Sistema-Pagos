import { isPeriod, periodFromDate, shiftPeriod } from '@/src/domain/periods';
import type { HomeRef, PaymentRecord } from '@/src/domain/types';

/**
 * Primer mes de servicio del sistema (docs/PLAN.md, seccion 1).
 *
 * La deuda anterior a septiembre de 2026 no se carga como meses: entra una sola
 * vez como `ajustes` de tipo SALDO_INICIAL. Por eso ningun pago se asigna a un
 * mes previo a este, y por eso ya no existe la regla especial de agosto.
 */
export const BASE_PERIOD = '2026-09';

/**
 * Invariante 5: estos estados liberan el mes. Todo lo demas lo mantiene
 * ocupado, incluido un pago apenas recibido y sin verificar — de lo contrario
 * dos comprobantes seguidos del mismo vecino chocan en el mismo mes.
 *
 * Un DUPLICADO tampoco reserva: no es un segundo pago, es el mismo dos veces.
 */
const LIBERAN_EL_MES = new Set<PaymentRecord['status']>(['NO_ENCONTRADO', 'RECHAZADO', 'DUPLICADO']);

export interface HomeForPeriod extends HomeRef {
  /** Fecha de alta. A una vivienda no se le cobran meses anteriores a ella. */
  startDate?: string;
}

function transactionPeriod(transactionDate: string | undefined, now: Date): string {
  const candidate = transactionDate?.slice(0, 7);
  return candidate && isPeriod(candidate) ? candidate : periodFromDate(now);
}

/** El mes del deposito, sin bajar nunca del primer mes de servicio. */
export function depositServicePeriod(transactionDate: string | undefined, now = new Date()): string {
  const period = transactionPeriod(transactionDate, now);
  return period < BASE_PERIOD ? BASE_PERIOD : period;
}

/** Desde que mes se le cobra a esta vivienda. */
function firstBillablePeriod(home: HomeForPeriod): string {
  const candidate = home.startDate?.slice(0, 7);
  const alta = candidate && isPeriod(candidate) ? candidate : BASE_PERIOD;
  return alta < BASE_PERIOD ? BASE_PERIOD : alta;
}

function sameHome(payment: PaymentRecord, home: HomeRef): boolean {
  return payment.stage === home.stage && payment.block === home.block && payment.house === home.house;
}

function periodsBetween(start: string, end: string): string[] {
  if (start > end) return [];
  const result: string[] = [];
  let current = start;
  while (current <= end && result.length < 240) {
    result.push(current);
    current = shiftPeriod(current, 1);
  }
  return result;
}

/**
 * A que mes de servicio corresponde un pago (docs/PLAN.md, invariante 5).
 *
 * Es el mes mas antiguo desde la fecha de alta de la vivienda que no tenga ya un
 * pago encima, sea verificado o pendiente. Nunca se asigna a meses futuros: el
 * tope es el mes del deposito, y si todos los meses hasta ahi estan ocupados el
 * pago se queda en ese mes y la deteccion de conflicto lo manda a revision, en
 * vez de adelantar una cuota en silencio.
 */
export function assignServicePeriod(
  home: HomeForPeriod,
  transactionDate: string | undefined,
  existingPayments: readonly PaymentRecord[],
  now = new Date(),
  excludePaymentId?: string,
): string {
  const desde = firstBillablePeriod(home);
  const deposito = transactionPeriod(transactionDate, now);
  // Una vivienda dada de alta despues del deposito arranca igual en su primer
  // mes: antes de existir no debia nada.
  const tope = deposito < desde ? desde : deposito;

  const ocupados = new Set(
    existingPayments
      .filter((payment) => payment.id !== excludePaymentId)
      .filter((payment) => !LIBERAN_EL_MES.has(payment.status))
      .filter((payment) => sameHome(payment, home))
      .map((payment) => payment.period),
  );

  return periodsBetween(desde, tope).find((period) => !ocupados.has(period)) ?? tope;
}

export function hasPeriodConflict(payment: PaymentRecord, existingPayments: readonly PaymentRecord[]): boolean {
  if (payment.stage == null || payment.block == null || payment.house == null) return false;
  return existingPayments.some((other) =>
    other.id !== payment.id
    && !LIBERAN_EL_MES.has(other.status)
    && other.stage === payment.stage
    && other.block === payment.block
    && other.house === payment.house
    && other.period === payment.period,
  );
}
