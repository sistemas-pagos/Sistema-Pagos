import { PAYMENT_STATUSES, type HomeRecord, type PaymentRecord, type PendingConversation, type ProcessedMessage } from '@/src/domain/types';

export const SHEETS = {
  payments: 'Pagos',
  homes: 'Viviendas',
  pending: 'Conversaciones',
  messages: 'Mensajes',
  reconciliation: 'Conciliacion',
  config: 'Configuracion',
} as const;

export const PAYMENT_HEADERS = [
  'id', 'created_at', 'updated_at', 'source_message_id', 'phone', 'bank', 'depositor',
  'transaction_date', 'transaction_time', 'amount', 'detail', 'reference', 'beneficiary', 'destination_account_masked',
  'stage', 'block', 'house', 'period', 'status', 'file_hash', 'duplicate_of', 'duplicate_reason', 'review_reason',
  'verification_source', 'verified_at', 'bank_movement_id',
] as const;
export const HOME_HEADERS = ['id', 'stage', 'block', 'house', 'responsible', 'monthly_fee', 'active', 'start_date', 'end_date'] as const;
export const PENDING_HEADERS = ['id', 'phone', 'payment_id', 'created_at', 'expires_at'] as const;
export const MESSAGE_HEADERS = ['message_id', 'received_at', 'kind', 'outcome'] as const;

const cell = (value: unknown): string | number | boolean => value == null ? '' : value as string | number | boolean;
const text = (value: unknown): string | undefined => value == null || value === '' ? undefined : String(value);
const int = (value: unknown): number | undefined => value == null || value === '' ? undefined : Number.parseInt(String(value), 10);
const num = (value: unknown): number => Number.parseFloat(String(value ?? 0)) || 0;
const bool = (value: unknown): boolean => value === true || String(value).toLowerCase() === 'true' || String(value) === '1';

export function paymentToRow(payment: PaymentRecord): Array<string | number | boolean> {
  return [
    payment.id, payment.createdAt, payment.updatedAt, payment.sourceMessageId, payment.phone,
    payment.bank, cell(payment.depositor), cell(payment.transactionDate), cell(payment.transactionTime), payment.amount, cell(payment.detail),
    cell(payment.reference), cell(payment.beneficiary), cell(payment.destinationAccountMasked), cell(payment.stage), cell(payment.block), cell(payment.house),
    payment.period, payment.status, payment.fileHash, cell(payment.duplicateOf), cell(payment.duplicateReason), cell(payment.reviewReason),
    cell(payment.verificationSource), cell(payment.verifiedAt), cell(payment.bankMovementId),
  ];
}

export function paymentFromRow(row: unknown[]): PaymentRecord | undefined {
  if (!row[0] || !row[3] || !row[5] || !row[18] || !row[19]) return undefined;
  const status = String(row[18]);
  if (!PAYMENT_STATUSES.includes(status as PaymentRecord['status'])) return undefined;
  return {
    id: String(row[0]), createdAt: String(row[1] ?? ''), updatedAt: String(row[2] ?? ''), sourceMessageId: String(row[3]),
    phone: String(row[4] ?? ''), bank: String(row[5]), depositor: text(row[6]), transactionDate: text(row[7]), transactionTime: text(row[8]),
    amount: num(row[9]), detail: text(row[10]), reference: text(row[11]), beneficiary: text(row[12]), destinationAccountMasked: text(row[13]),
    stage: int(row[14]), block: int(row[15]), house: int(row[16]), period: String(row[17] ?? ''), status: status as PaymentRecord['status'],
    fileHash: String(row[19]), duplicateOf: text(row[20]), duplicateReason: text(row[21]), reviewReason: text(row[22]),
    verificationSource: text(row[23]), verifiedAt: text(row[24]), bankMovementId: text(row[25]),
  };
}

export function homeToRow(home: HomeRecord): Array<string | number | boolean> {
  return [home.id, home.stage, home.block, home.house, cell(home.responsible), home.monthlyFee, home.active, cell(home.startDate), cell(home.endDate)];
}

export function homeFromRow(row: unknown[]): HomeRecord | undefined {
  const stage = int(row[1]);
  const block = int(row[2]);
  const house = int(row[3]);
  if (!row[0] || stage == null || block == null || house == null) return undefined;
  return { id: String(row[0]), stage, block, house, responsible: text(row[4]), monthlyFee: num(row[5]), active: bool(row[6]), startDate: text(row[7]), endDate: text(row[8]) };
}

export function pendingToRow(pending: PendingConversation): string[] {
  return [pending.id, pending.phone, pending.paymentId, pending.createdAt, pending.expiresAt];
}

export function pendingFromRow(row: unknown[]): PendingConversation | undefined {
  if (!row[0] || !row[1] || !row[2]) return undefined;
  return { id: String(row[0]), phone: String(row[1]), paymentId: String(row[2]), createdAt: String(row[3] ?? ''), expiresAt: String(row[4] ?? '') };
}

export function messageToRow(message: ProcessedMessage): string[] {
  return [message.messageId, message.receivedAt, message.kind, message.outcome];
}

export function messageFromRow(row: unknown[]): ProcessedMessage | undefined {
  if (!row[0] || !row[1] || !row[2] || !row[3]) return undefined;
  const kind = String(row[2]);
  const outcome = String(row[3]);
  if (!['image', 'text', 'document', 'other'].includes(kind) || !['processed', 'ignored', 'rejected'].includes(outcome)) return undefined;
  return { messageId: String(row[0]), receivedAt: String(row[1]), kind: kind as ProcessedMessage['kind'], outcome: outcome as ProcessedMessage['outcome'] };
}
