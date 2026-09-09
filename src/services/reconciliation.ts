import type { PaymentRecord } from '@/src/domain/types';
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
}

function normalized(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

interface Candidate {
  payment: PaymentRecord;
  movementIndex?: number;
  movementId?: string;
  outcome: 'candidate' | 'not_found' | 'review';
  reason?: string;
}

export async function reconcilePendingPayments(
  store: PaymentStore,
  movements: readonly BankMovement[],
  source: string,
  now = new Date(),
): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = { verified: 0, notFound: 0, review: 0 };
  const allPayments = await store.listPayments();
  const payments = allPayments.filter((payment) => payment.status === 'PENDIENTE_VERIFICACION' || payment.status === 'NO_ENCONTRADO');
  const movementOwners = new Map<string, string>();
  allPayments.forEach((payment) => {
    if (payment.bankMovementId) movementOwners.set(payment.bankMovementId, payment.id);
  });

  const candidates: Candidate[] = payments.map((payment) => {
    if (!payment.reference) return { payment, outcome: 'review', reason: 'reference_missing_for_reconciliation' };

    const matches = movements
      .map((movement, index) => ({ movement, index }))
      .filter(({ movement }) =>
        normalized(movement.bank) === normalized(payment.bank)
        && normalized(movement.reference) === normalized(payment.reference!)
        && movement.amount === payment.amount,
      );

    if (matches.length === 0) return { payment, outcome: 'not_found', reason: 'bank_movement_not_found' };
    if (matches.length > 1) return { payment, outcome: 'review', reason: 'reconciliation_ambiguous' };

    const { movement, index } = matches[0];
    if (payment.transactionDate && movement.transactionDate && payment.transactionDate !== movement.transactionDate) {
      return { payment, outcome: 'review', reason: 'reconciliation_date_conflict' };
    }

    const movementId = movement.id?.trim();
    if (!movementId) return { payment, outcome: 'review', reason: 'bank_movement_id_missing' };

    const owner = movementOwners.get(movementId);
    if (owner && owner !== payment.id) {
      return { payment, outcome: 'review', reason: 'bank_movement_already_used' };
    }

    return { payment, movementIndex: index, movementId, outcome: 'candidate' };
  });

  const claims = new Map<string, number>();
  candidates.forEach((candidate) => {
    if (candidate.outcome === 'candidate' && candidate.movementId) {
      claims.set(candidate.movementId, (claims.get(candidate.movementId) ?? 0) + 1);
    }
  });

  for (const candidate of candidates) {
    const { payment } = candidate;
    let updated: PaymentRecord;
    if (candidate.outcome === 'candidate' && candidate.movementId && claims.get(candidate.movementId) === 1) {
      updated = {
        ...payment,
        status: 'VERIFICADO',
        reviewReason: undefined,
        verificationSource: source,
        verifiedAt: now.toISOString(),
        bankMovementId: candidate.movementId,
        updatedAt: now.toISOString(),
      };
      summary.verified += 1;
    } else if (candidate.outcome === 'not_found') {
      updated = { ...payment, status: 'NO_ENCONTRADO', reviewReason: candidate.reason, updatedAt: now.toISOString() };
      summary.notFound += 1;
    } else {
      const reason = candidate.outcome === 'candidate' ? 'reconciliation_movement_claimed_multiple_times' : candidate.reason;
      updated = { ...payment, status: 'EN_REVISION', reviewReason: reason, updatedAt: now.toISOString() };
      summary.review += 1;
    }
    await store.updatePayment(updated);
  }

  return summary;
}
