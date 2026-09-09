import { env } from '@/src/config/env';
import type { PaymentRecord } from '@/src/domain/types';

const NON_VERIFIABLE_REVIEW_REASONS = new Set([
  'amount_below_expected',
  'amount_above_expected',
  'service_period_already_has_payment',
  'reconciliation_movement_claimed_multiple_times',
  'bank_movement_already_used',
]);

function hasExpectedAmount(payment: PaymentRecord): boolean {
  return Math.abs(payment.amount - env().EXPECTED_PAYMENT_AMOUNT) <= 0.005;
}

export function hasVerifiedServicePeriodConflict(
  payment: PaymentRecord,
  existingPayments: readonly PaymentRecord[],
): boolean {
  if (payment.stage == null || payment.block == null || payment.house == null) return false;
  return existingPayments.some((other) =>
    other.id !== payment.id
    && other.status === 'VERIFICADO'
    && other.stage === payment.stage
    && other.block === payment.block
    && other.house === payment.house
    && other.period === payment.period,
  );
}

export function canManuallyVerify(payment: PaymentRecord, includeReview = false): boolean {
  const statusAllowed = payment.status === 'PENDIENTE_VERIFICACION' || (includeReview && payment.status === 'EN_REVISION');
  if (!statusAllowed) return false;
  // Re-check the amount itself at the verification boundary. A different review reason
  // must never accidentally hide an amount exception and make a non-L150 payment verifiable.
  if (!hasExpectedAmount(payment)) return false;
  if (payment.reviewReason && NON_VERIFIABLE_REVIEW_REASONS.has(payment.reviewReason)) return false;

  return payment.stage != null
    && payment.block != null
    && payment.house != null;
}

export function buildManualVerificationUpdate(
  payment: PaymentRecord,
  existingPayments: readonly PaymentRecord[],
  now = new Date(),
  includeReview = false,
): PaymentRecord {
  if (!canManuallyVerify(payment, includeReview)) {
    throw new Error('payment_not_manually_verifiable');
  }
  if (hasVerifiedServicePeriodConflict(payment, existingPayments)) {
    throw new Error('service_period_already_verified');
  }

  const at = now.toISOString();
  return {
    ...payment,
    status: 'VERIFICADO',
    reviewReason: undefined,
    verificationSource: includeReview ? 'manual_admin_bank_check_after_review' : 'manual_admin_bank_check',
    verifiedAt: at,
    updatedAt: at,
  };
}
