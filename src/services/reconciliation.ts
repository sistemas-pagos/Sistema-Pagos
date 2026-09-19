import { env } from '@/src/config/env';
import type { PaymentRecord } from '@/src/domain/types';
import { hasPeriodConflict } from '@/src/services/period-assignment';
import type { PaymentStore } from '@/src/storage/types';

export interface BankMovement {
  /** Stable identifier supplied by the authorized bank-side source/import. */
  id?: string;
  bank: string;
  reference: string;
  amount: number;
  transactionDate?: string;
}

export interface ReconciliationSummary {
  verified: number;
  notFound: number;
  review: number;
  /** Recibos emitidos en esta corrida. Uno por pago verificado (invariante 10). */
  receipts: number;
}

function normalized(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function amountReviewReason(payment: PaymentRecord): string | undefined {
  const difference = payment.amount - env().EXPECTED_PAYMENT_AMOUNT;
  if (Math.abs(difference) <= 0.005) return undefined;
  return difference < 0 ? 'amount_below_expected' : 'amount_above_expected';
}

export type ReconciliationOutcome = 'verify' | 'not_found' | 'review';

export interface ReconciliationDecision {
  payment: PaymentRecord;
  outcome: ReconciliationOutcome;
  /** Solo cuando el resultado es `verify`. */
  movementId?: string;
  reason?: string;
}

export interface ReconciliationPlan {
  decisions: ReconciliationDecision[];
  /**
   * Depositos que entraron a la cuenta y ningun comprobante reclama: plata que
   * esta en el banco y no se sabe de que casa es. No es un error del sistema
   * —el vecino puede no haber mandado nada—, pero es lo que el tesorero tiene
   * que salir a buscar, asi que se cuenta aparte en vez de ignorarse.
   */
  unclaimedMovements: BankMovement[];
}

interface Candidate {
  payment: PaymentRecord;
  /** Los depositos a los que apunta este comprobante, pase lo que pase con el. */
  matched: number[];
  movementId?: string;
  outcome: 'candidate' | 'not_found' | 'review';
  reason?: string;
}

/**
 * Decide que pasaria con cada pago y cada deposito, sin escribir nada.
 *
 * El resumen que el tesorero confirma y la aplicacion que sigue leen este
 * mismo plan. Si fueran dos recorridos distintos, tarde o temprano dirian
 * cosas distintas y el "SI" dejaria de significar lo que se mostro.
 */
export function planReconciliation(
  allPayments: readonly PaymentRecord[],
  movements: readonly BankMovement[],
): ReconciliationPlan {
  const payments = allPayments.filter((payment) => payment.status === 'PENDIENTE_VERIFICACION' || payment.status === 'NO_ENCONTRADO');
  const movementOwners = new Map<string, string>();
  allPayments.forEach((payment) => {
    if (payment.bankMovementId) movementOwners.set(payment.bankMovementId, payment.id);
  });

  const candidates: Candidate[] = payments.map((payment) => {
    // A que depositos apunta el comprobante se busca primero y aparte de si el
    // pago pasa las validaciones. Un comprobante que termina en revision sigue
    // explicando de donde salio ese deposito, y el tesorero no tiene por que
    // salir a buscar un dinero que ya tiene duenio conocido.
    const matches = payment.reference
      ? movements
        .map((movement, index) => ({ movement, index }))
        .filter(({ movement }) =>
          normalized(movement.bank) === normalized(payment.bank)
          && normalized(movement.reference) === normalized(payment.reference!)
          && movement.amount === payment.amount,
        )
      : [];
    const matched = matches.map(({ index }) => index);

    // Reconciliation is a verification boundary, so it re-validates invariants rather
    // than trusting the persisted status/reviewReason. This also protects against manual
    // Sheet edits or a different review reason masking a simultaneous exception.
    if (payment.stage == null || payment.block == null || payment.house == null) {
      return { payment, matched, outcome: 'review', reason: 'home_missing_for_reconciliation' };
    }
    const amountReason = amountReviewReason(payment);
    if (amountReason) return { payment, matched, outcome: 'review', reason: amountReason };
    if (hasPeriodConflict(payment, allPayments)) {
      return { payment, matched, outcome: 'review', reason: 'service_period_already_has_payment' };
    }
    if (!payment.reference) return { payment, matched, outcome: 'review', reason: 'reference_missing_for_reconciliation' };

    if (matches.length === 0) return { payment, matched, outcome: 'not_found', reason: 'bank_movement_not_found' };
    if (matches.length > 1) return { payment, matched, outcome: 'review', reason: 'reconciliation_ambiguous' };

    const { movement } = matches[0];
    if (payment.transactionDate && movement.transactionDate && payment.transactionDate !== movement.transactionDate) {
      return { payment, matched, outcome: 'review', reason: 'reconciliation_date_conflict' };
    }

    const movementId = movement.id?.trim();
    if (!movementId) return { payment, matched, outcome: 'review', reason: 'bank_movement_id_missing' };

    const owner = movementOwners.get(movementId);
    if (owner && owner !== payment.id) {
      return { payment, matched, outcome: 'review', reason: 'bank_movement_already_used' };
    }

    return { payment, matched, movementId, outcome: 'candidate' };
  });

  const claims = new Map<string, number>();
  candidates.forEach((candidate) => {
    if (candidate.outcome === 'candidate' && candidate.movementId) {
      claims.set(candidate.movementId, (claims.get(candidate.movementId) ?? 0) + 1);
    }
  });

  const decisions: ReconciliationDecision[] = candidates.map((candidate) => {
    if (candidate.outcome === 'candidate' && candidate.movementId && claims.get(candidate.movementId) === 1) {
      return { payment: candidate.payment, outcome: 'verify', movementId: candidate.movementId };
    }
    if (candidate.outcome === 'not_found') {
      return { payment: candidate.payment, outcome: 'not_found', reason: candidate.reason };
    }
    return {
      payment: candidate.payment,
      outcome: 'review',
      reason: candidate.outcome === 'candidate' ? 'reconciliation_movement_claimed_multiple_times' : candidate.reason,
    };
  });

  // Un deposito esta reclamado si algun comprobante apunta a el, aunque ese
  // comprobante termine en revision: el dinero ya tiene duenio conocido.
  const reclamados = new Set(candidates.flatMap((candidate) => candidate.matched));
  const unclaimedMovements = movements.filter((movement, index) =>
    !reclamados.has(index) && !(movement.id && movementOwners.has(movement.id)));

  return { decisions, unclaimedMovements };
}

/**
 * Aplica el plan: verifica, emite los recibos y cierra los que no cuadran.
 *
 * `verifiedBy` es el `usuarios.id` de quien mando el extracto. Queda en el pago
 * y en el evento: cuando alguien pregunte por que un pago quedo verificado, eso
 * es lo que lo responde.
 */
export async function reconcilePendingPayments(
  store: PaymentStore,
  movements: readonly BankMovement[],
  source: string,
  now = new Date(),
  verifiedBy?: string,
): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = { verified: 0, notFound: 0, review: 0, receipts: 0 };
  const { decisions } = planReconciliation(await store.listPayments(), movements);

  for (const decision of decisions) {
    const { payment } = decision;

    if (decision.outcome === 'verify') {
      // Verificar y emitir el recibo van juntos: el vecino que pago tiene que
      // recibir su comprobante, y un pago verificado sin recibo no se le nota
      // a nadie desde el tablero.
      await store.verifyPayment({
        ...payment,
        status: 'VERIFICADO',
        reviewReason: undefined,
        verificationSource: source,
        verifiedAt: now.toISOString(),
        bankMovementId: decision.movementId,
        updatedAt: now.toISOString(),
      }, verifiedBy);
      summary.verified += 1;
      summary.receipts += 1;
      continue;
    }

    let updated: PaymentRecord;
    if (decision.outcome === 'not_found') {
      updated = { ...payment, status: 'NO_ENCONTRADO', reviewReason: decision.reason, updatedAt: now.toISOString() };
      summary.notFound += 1;
    } else {
      updated = { ...payment, status: 'EN_REVISION', reviewReason: decision.reason, updatedAt: now.toISOString() };
      summary.review += 1;
    }
    await store.updatePayment(updated);
  }

  return summary;
}
