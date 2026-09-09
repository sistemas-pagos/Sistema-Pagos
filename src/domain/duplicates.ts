import type { HomeRef, PaymentRecord } from './types';

export type DuplicateDecision =
  | { kind: 'none' }
  | { kind: 'retry'; original: PaymentRecord; reason: 'message_id' }
  | { kind: 'duplicate'; original: PaymentRecord; reason: 'file_hash' }
  | { kind: 'conflict'; original: PaymentRecord; reason: 'bank_reference_home_conflict' | 'bank_reference_data_conflict' }
  | { kind: 'review'; original: PaymentRecord; reason: 'bank_reference_reused' | 'weak_signature' };

export interface DuplicateProbe {
  sourceMessageId: string;
  fileHash: string;
  bank: string;
  reference?: string;
  amount?: number;
  transactionDate?: string;
  home?: HomeRef;
}

function sameHome(record: PaymentRecord, home: HomeRef | undefined): boolean {
  if (!home || record.stage == null || record.block == null || record.house == null) return true;
  return record.stage === home.stage && record.block === home.block && record.house === home.house;
}

function normalized(value: string | undefined): string | undefined {
  const text = value?.trim().toUpperCase().replace(/\s+/g, '');
  return text || undefined;
}

export function decideDuplicate(probe: DuplicateProbe, existing: readonly PaymentRecord[]): DuplicateDecision {
  const byMessage = existing.find((record) => record.sourceMessageId === probe.sourceMessageId);
  if (byMessage) return { kind: 'retry', original: byMessage, reason: 'message_id' };

  const byHash = existing.find((record) => record.fileHash === probe.fileHash && record.status !== 'DUPLICADO');
  if (byHash) return { kind: 'duplicate', original: byHash, reason: 'file_hash' };

  const reference = normalized(probe.reference);
  if (reference) {
    const byReference = existing.find(
      (record) => normalized(record.bank) === normalized(probe.bank) && normalized(record.reference) === reference,
    );
    if (byReference) {
      if (!sameHome(byReference, probe.home)) {
        return { kind: 'conflict', original: byReference, reason: 'bank_reference_home_conflict' };
      }
      const amountConflict = probe.amount != null && byReference.amount !== probe.amount;
      const dateConflict = Boolean(probe.transactionDate && byReference.transactionDate && byReference.transactionDate !== probe.transactionDate);
      if (amountConflict || dateConflict) {
        return { kind: 'conflict', original: byReference, reason: 'bank_reference_data_conflict' };
      }
      // A bank reference is not assumed globally unique. Reuse is a review signal only.
      return { kind: 'review', original: byReference, reason: 'bank_reference_reused' };
    }
  }

  if (probe.amount != null && probe.transactionDate && probe.home) {
    const weak = existing.find(
      (record) =>
        normalized(record.bank) === normalized(probe.bank)
        && sameHome(record, probe.home)
        && record.amount === probe.amount
        && record.transactionDate === probe.transactionDate
        && record.status !== 'DUPLICADO'
        && record.status !== 'RECHAZADO',
    );
    if (weak) return { kind: 'review', original: weak, reason: 'weak_signature' };
  }

  return { kind: 'none' };
}
