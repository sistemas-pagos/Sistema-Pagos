import { env } from '@/src/config/env';
import type { ReceiptExtraction } from '@/src/domain/types';

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function receiptReviewReason(extraction: ReceiptExtraction): string | undefined {
  const config = env();
  if (!extraction.amount || extraction.amount <= 0) return 'amount_missing';

  const amountDifference = extraction.amount - config.EXPECTED_PAYMENT_AMOUNT;
  if (Math.abs(amountDifference) > 0.005) {
    return amountDifference < 0 ? 'amount_below_expected' : 'amount_above_expected';
  }

  if (extraction.confidence < 0.55) return 'ocr_low_confidence';

  if (config.EXPECTED_BENEFICIARY) {
    const expected = normalizeName(config.EXPECTED_BENEFICIARY);
    const actual = extraction.beneficiary ? normalizeName(extraction.beneficiary) : '';
    if (!actual) return 'beneficiary_unreadable';
    if (!actual.includes(expected) && !expected.includes(actual)) return 'beneficiary_unexpected';
  }

  if (config.EXPECTED_ACCOUNT_LAST4) {
    const actual = extraction.destinationAccountMasked?.replace(/\D/g, '').slice(-4);
    if (!actual) return 'destination_account_unreadable';
    if (actual !== config.EXPECTED_ACCOUNT_LAST4) return 'destination_account_unexpected';
  }

  return undefined;
}
