import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { buildManualVerificationUpdate, canManuallyVerify, hasVerifiedServicePeriodConflict } from '@/src/services/manual-verification';
import type { PaymentRecord } from '@/src/domain/types';

const payment: PaymentRecord = {
  id: 'pay-demo', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceMessageId: 'msg-demo',
  phone: '+50400000000', bank: 'BAC Honduras', amount: 150, transactionDate: '2026-09-01', reference: 'DEMO-REF-001',
  stage: 1, block: 4, house: 18, period: '2026-08', status: 'PENDIENTE_VERIFICACION', fileHash: 'demo-hash',
};

beforeEach(() => {
  delete process.env.EXPECTED_PAYMENT_AMOUNT;
  resetEnvForTests();
});

describe('manual verification', () => {
  it('allows an identified payment pending bank verification', () => {
    expect(canManuallyVerify(payment)).toBe(true);
  });

  it('records a manual bank check with timestamp and source', () => {
    const updated = buildManualVerificationUpdate(payment, [payment], new Date('2026-09-09T20:30:00.000Z'));
    expect(updated.status).toBe('VERIFICADO');
    expect(updated.verificationSource).toBe('manual_admin_bank_check');
    expect(updated.verifiedAt).toBe('2026-09-09T20:30:00.000Z');
  });

  it('requires explicit reviewed mode for a resolvable EN_REVISION payment', () => {
    const reviewed = { ...payment, status: 'EN_REVISION' as const, reviewReason: 'bank_reference_reused' };
    expect(canManuallyVerify(reviewed)).toBe(false);
    expect(canManuallyVerify(reviewed, true)).toBe(true);
    expect(buildManualVerificationUpdate(reviewed, [reviewed], new Date('2026-09-09T20:30:00.000Z'), true).verificationSource)
      .toBe('manual_admin_bank_check_after_review');
  });

  it('keeps payments above or below L150 in review even after a bank check', () => {
    const below = { ...payment, amount: 149, status: 'EN_REVISION' as const, reviewReason: 'amount_below_expected' };
    const above = { ...payment, amount: 151, status: 'EN_REVISION' as const, reviewReason: 'amount_above_expected' };
    expect(canManuallyVerify(below, true)).toBe(false);
    expect(canManuallyVerify(above, true)).toBe(false);
    expect(() => buildManualVerificationUpdate(above, [above], new Date(), true)).toThrow('payment_not_manually_verifiable');
  });

  it('checks the actual amount even when another review reason replaced the amount warning', () => {
    const maskedAmountException = { ...payment, amount: 175, status: 'EN_REVISION' as const, reviewReason: 'pending_context_conflict' };
    expect(canManuallyVerify(maskedAmountException, true)).toBe(false);
  });

  it('respects a configured expected amount at the final verification boundary', () => {
    process.env.EXPECTED_PAYMENT_AMOUNT = '200';
    resetEnvForTests();
    expect(canManuallyVerify({ ...payment, amount: 150 })).toBe(false);
    expect(canManuallyVerify({ ...payment, amount: 200 })).toBe(true);
  });

  it('does not allow a conflicting service month to be verified until the period is corrected', () => {
    const conflict = { ...payment, status: 'EN_REVISION' as const, reviewReason: 'service_period_already_has_payment' };
    expect(canManuallyVerify(conflict, true)).toBe(false);
  });

  it('does not override evidence that a bank movement is already claimed or reused', () => {
    const claimed = { ...payment, status: 'EN_REVISION' as const, reviewReason: 'reconciliation_movement_claimed_multiple_times' };
    const reused = { ...payment, status: 'EN_REVISION' as const, reviewReason: 'bank_movement_already_used' };
    expect(canManuallyVerify(claimed, true)).toBe(false);
    expect(canManuallyVerify(reused, true)).toBe(false);
  });

  it('does not allow incomplete EBC or duplicate payments to be verified', () => {
    expect(canManuallyVerify({ ...payment, stage: undefined, status: 'ESPERANDO_RESPUESTA' })).toBe(false);
    expect(canManuallyVerify({ ...payment, status: 'DUPLICADO' })).toBe(false);
  });

  it('blocks a second manual verification for the same home and service month', () => {
    const alreadyVerified: PaymentRecord = {
      ...payment,
      id: 'pay-already-verified',
      sourceMessageId: 'msg-already-verified',
      fileHash: 'hash-already-verified',
      status: 'VERIFICADO',
      verificationSource: 'manual_admin_bank_check',
      verifiedAt: '2026-09-09T18:00:00.000Z',
    };
    expect(hasVerifiedServicePeriodConflict(payment, [payment, alreadyVerified])).toBe(true);
    expect(() => buildManualVerificationUpdate(payment, [payment, alreadyVerified], new Date('2026-09-09T20:30:00.000Z')))
      .toThrow('service_period_already_verified');
  });

  it('blocks a reviewed payment when another receipt for the same home/month masks the period conflict', () => {
    const reviewed: PaymentRecord = {
      ...payment,
      id: 'pay-reviewed',
      sourceMessageId: 'msg-reviewed',
      fileHash: 'hash-reviewed',
      status: 'EN_REVISION',
      reviewReason: 'bank_reference_reused',
    };
    const original: PaymentRecord = {
      ...payment,
      id: 'pay-original',
      sourceMessageId: 'msg-original',
      fileHash: 'hash-original',
      reference: 'DEMO-REF-002',
    };
    expect(canManuallyVerify(reviewed, true)).toBe(true);
    expect(() => buildManualVerificationUpdate(reviewed, [reviewed, original], new Date('2026-09-09T20:30:00.000Z'), true))
      .toThrow('service_period_conflict_under_review');
  });

  it('allows verification when the other verified payment belongs to another service month', () => {
    const otherMonth: PaymentRecord = {
      ...payment,
      id: 'pay-other-month',
      sourceMessageId: 'msg-other-month',
      fileHash: 'hash-other-month',
      period: '2026-07',
      status: 'VERIFICADO',
    };
    expect(hasVerifiedServicePeriodConflict(payment, [payment, otherMonth])).toBe(false);
    expect(buildManualVerificationUpdate(payment, [payment, otherMonth]).status).toBe('VERIFICADO');
  });
});
