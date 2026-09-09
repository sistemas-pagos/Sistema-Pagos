import { createHash } from 'node:crypto';
import { env } from '@/src/config/env';
import { decideDuplicate } from '@/src/domain/duplicates';
import { parseHomeReference } from '@/src/domain/housing';
import { periodLabel } from '@/src/domain/periods';
import { samePhone } from '@/src/domain/phone';
import type { HomeRef, PaymentRecord, PendingConversation, ProcessedMessage } from '@/src/domain/types';
import { recognizeReceipt } from '@/src/ocr/tesseract';
import { detectAndParseReceipt } from '@/src/parsers';
import { validateReceiptFile } from '@/src/security/files';
import type { PaymentStore } from '@/src/storage/types';
import { assignServicePeriod, baselinePeriodFromDepositDate, hasPeriodConflict } from './period-assignment';
import { receiptReviewReason } from './validation';

export interface ProcessorDependencies {
  store: PaymentStore;
  now?: () => Date;
  ocr?: (bytes: Buffer) => Promise<{ text: string; confidence: number }>;
}

export interface ReceiptMessageInput {
  messageId: string;
  phone: string;
  bytes: Uint8Array;
  declaredMime?: string;
  kind?: 'image' | 'document';
  syntheticOcrText?: string;
}

export interface ProcessOutcome {
  action: 'reply' | 'silent';
  reply?: string;
  paymentId?: string;
  status?: PaymentRecord['status'];
  reason?: string;
}

const activeMessages = new Set<string>();

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function amountLabel(amount: number): string {
  return `L${amount.toFixed(2)}`;
}

function dateLabel(iso: string | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function receiptAcceptedReply(payment: PaymentRecord): string {
  const lines = [
    '✅ Comprobante recibido',
    `Etapa ${payment.stage} · Bloque ${payment.block} · Casa ${payment.house}`,
    amountLabel(payment.amount),
  ];
  const date = dateLabel(payment.transactionDate);
  if (date) lines.push(`Fecha depósito: ${date}`);
  lines.push(`Mes aplicado: ${periodLabel(payment.period)}`);
  lines.push('Estado: pendiente de verificación.');
  return lines.join('\n');
}

function unidentifiedReply(payment: PaymentRecord): string {
  return [
    `Recibimos tu comprobante por ${amountLabel(payment.amount)}, pero falta identificar completamente la vivienda.`,
    'Por favor responde con etapa, bloque y casa.',
    'Ejemplo: E1 B4 C18',
  ].join('\n');
}

function reviewReply(): string {
  return 'Recibimos tu comprobante y quedó en revisión. No se registrará como pago verificado hasta confirmar la transacción.';
}

function duplicateReply(): string {
  return 'ℹ️ Este mismo comprobante ya había sido recibido. No se registró un segundo pago.';
}

async function markMessage(
  store: PaymentStore,
  messageId: string,
  kind: ProcessedMessage['kind'],
  outcome: ProcessedMessage['outcome'],
  at: string,
): Promise<void> {
  await store.saveProcessedMessage({ messageId, kind, outcome, receivedAt: at });
}

function duplicateRecord(original: PaymentRecord, input: ReceiptMessageInput, fileHash: string, at: string, status: 'DUPLICADO' | 'EN_REVISION', reason: string): PaymentRecord {
  return {
    ...original,
    id: deterministicId('pay', input.messageId),
    createdAt: at,
    updatedAt: at,
    sourceMessageId: input.messageId,
    phone: input.phone,
    status,
    fileHash,
    duplicateOf: original.id,
    duplicateReason: reason,
    reviewReason: status === 'EN_REVISION' ? reason : undefined,
    verifiedAt: undefined,
    verificationSource: undefined,
    bankMovementId: undefined,
  };
}

async function resolveHome(store: PaymentStore, parsedHome: HomeRef | undefined): Promise<{ home?: HomeRef; warning?: string }> {
  if (!parsedHome) return {};
  const homes = await store.listHomes();
  const match = homes.find((home) =>
    home.active
    && home.stage === parsedHome.stage
    && home.block === parsedHome.block
    && home.house === parsedHome.house,
  );
  if (match) return { home: parsedHome };
  return { warning: 'receipt_home_not_in_master' };
}

export async function processReceiptMessage(input: ReceiptMessageInput, deps: ProcessorDependencies): Promise<ProcessOutcome> {
  const { store } = deps;
  if (activeMessages.has(input.messageId)) return { action: 'silent', reason: 'technical_retry_in_flight' };
  if (await store.hasProcessedMessage(input.messageId)) return { action: 'silent', reason: 'technical_retry' };

  activeMessages.add(input.messageId);
  try {
    const now = deps.now?.() ?? new Date();
    const at = now.toISOString();
    const kind = input.kind ?? 'image';
    const validated = validateReceiptFile(input.bytes, input.declaredMime);
    const existing = await store.listPayments();

    const byMessage = existing.find((payment) => payment.sourceMessageId === input.messageId);
    if (byMessage) {
      await markMessage(store, input.messageId, kind, 'ignored', at);
      return { action: 'silent', paymentId: byMessage.id, status: byMessage.status, reason: 'technical_retry' };
    }

    const byHash = existing.find((payment) => payment.fileHash === validated.sha256 && payment.status !== 'DUPLICADO');
    if (byHash) {
      const crossSender = !samePhone(byHash.phone, input.phone);
      const record = duplicateRecord(
        byHash,
        input,
        validated.sha256,
        at,
        crossSender ? 'EN_REVISION' : 'DUPLICADO',
        crossSender ? 'exact_file_other_sender' : 'file_hash',
      );
      await store.savePayment(record);
      await markMessage(store, input.messageId, kind, 'processed', at);
      return {
        action: 'reply',
        reply: crossSender ? reviewReply() : duplicateReply(),
        paymentId: record.id,
        status: record.status,
        reason: record.reviewReason ?? record.duplicateReason,
      };
    }

    let text: string;
    let ocrConfidence: number;
    try {
      const ocrResult = input.syntheticOcrText != null
        ? { text: input.syntheticOcrText, confidence: 1 }
        : await (deps.ocr ?? recognizeReceipt)(validated.bytes);
      text = ocrResult.text;
      ocrConfidence = ocrResult.confidence;
    } catch {
      await markMessage(store, input.messageId, kind, 'rejected', at);
      return { action: 'reply', reply: 'No pudimos leer el comprobante. Envíalo nuevamente como una imagen clara.', reason: 'ocr_failed' };
    }

    let extraction;
    try {
      extraction = detectAndParseReceipt(text);
      extraction.confidence = Math.min(extraction.confidence, ocrConfidence || extraction.confidence);
    } catch {
      await markMessage(store, input.messageId, kind, 'rejected', at);
      return { action: 'reply', reply: 'No pudimos identificar un comprobante BAC válido. No se registró ningún pago.', reason: 'unsupported_receipt' };
    }

    if (!extraction.amount || extraction.amount <= 0) {
      await markMessage(store, input.messageId, kind, 'rejected', at);
      return { action: 'reply', reply: 'No pudimos leer el monto del comprobante. No se registró ningún pago.', reason: 'amount_missing' };
    }

    const homeResolution = await resolveHome(store, extraction.home);
    const home = homeResolution.home;
    const duplicate = decideDuplicate({
      sourceMessageId: input.messageId,
      fileHash: validated.sha256,
      bank: extraction.bank,
      reference: extraction.reference,
      amount: extraction.amount,
      transactionDate: extraction.transactionDate,
      home,
    }, existing);

    if (duplicate.kind === 'retry') {
      await markMessage(store, input.messageId, kind, 'ignored', at);
      return { action: 'silent', paymentId: duplicate.original.id, status: duplicate.original.status, reason: duplicate.reason };
    }

    if (duplicate.kind === 'duplicate') {
      const record = duplicateRecord(duplicate.original, input, validated.sha256, at, 'DUPLICADO', duplicate.reason);
      await store.savePayment(record);
      await markMessage(store, input.messageId, kind, 'processed', at);
      return { action: 'reply', reply: duplicateReply(), paymentId: record.id, status: record.status, reason: duplicate.reason };
    }

    let reviewReason = receiptReviewReason(extraction) ?? homeResolution.warning;
    if (duplicate.kind === 'conflict' || duplicate.kind === 'review') reviewReason = duplicate.reason;

    let status: PaymentRecord['status'] = reviewReason ? 'EN_REVISION' : 'PENDIENTE_VERIFICACION';
    let shouldAskHome = false;
    let pendingConflict = false;
    if (!home && duplicate.kind !== 'conflict') {
      const existingPending = await store.getPendingByPhone(input.phone);
      if (existingPending) {
        pendingConflict = true;
        status = 'EN_REVISION';
        reviewReason = 'pending_context_conflict';
      } else {
        status = 'ESPERANDO_RESPUESTA';
        shouldAskHome = true;
      }
    }

    const period = home
      ? assignServicePeriod(home, extraction.transactionDate, existing, now)
      : baselinePeriodFromDepositDate(extraction.transactionDate, now);

    let record: PaymentRecord = {
      id: deterministicId('pay', input.messageId),
      createdAt: at,
      updatedAt: at,
      sourceMessageId: input.messageId,
      phone: input.phone,
      bank: extraction.bank,
      depositor: extraction.depositor,
      transactionDate: extraction.transactionDate,
      transactionTime: extraction.transactionTime,
      amount: extraction.amount,
      detail: extraction.detail,
      reference: extraction.reference,
      beneficiary: extraction.beneficiary,
      destinationAccountMasked: extraction.destinationAccountMasked,
      stage: home?.stage,
      block: home?.block,
      house: home?.house,
      period,
      status,
      fileHash: validated.sha256,
      duplicateOf: duplicate.kind === 'conflict' || duplicate.kind === 'review' ? duplicate.original.id : undefined,
      duplicateReason: duplicate.kind === 'conflict' || duplicate.kind === 'review' ? duplicate.reason : undefined,
      reviewReason,
    };

    if (home && hasPeriodConflict(record, existing) && !record.reviewReason) {
      record = { ...record, status: 'EN_REVISION', reviewReason: 'service_period_already_has_payment' };
    }

    await store.savePayment(record);

    if (shouldAskHome) {
      const minutes = env().PENDING_CONTEXT_MINUTES;
      const pending: PendingConversation = {
        id: deterministicId('ctx', `${input.phone}:${record.id}`),
        phone: input.phone,
        paymentId: record.id,
        createdAt: at,
        expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      };
      await store.savePending(pending);
    }

    await markMessage(store, input.messageId, kind, 'processed', at);

    if (shouldAskHome) return { action: 'reply', reply: unidentifiedReply(record), paymentId: record.id, status: record.status, reason: reviewReason };
    if (pendingConflict || record.status === 'EN_REVISION') return { action: 'reply', reply: reviewReply(), paymentId: record.id, status: record.status, reason: record.reviewReason };
    return { action: 'reply', reply: receiptAcceptedReply(record), paymentId: record.id, status: record.status };
  } finally {
    activeMessages.delete(input.messageId);
  }
}

export async function processHomeReply(messageId: string, phone: string, body: string, deps: ProcessorDependencies): Promise<ProcessOutcome> {
  const { store } = deps;
  if (await store.hasProcessedMessage(messageId)) return { action: 'silent', reason: 'technical_retry' };
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const pending = await store.getPendingByPhone(phone);

  if (!pending) {
    await markMessage(store, messageId, 'text', 'ignored', at);
    return { action: 'silent', reason: 'no_pending_receipt' };
  }

  const home = parseHomeReference(body);
  if (!home) {
    await markMessage(store, messageId, 'text', 'processed', at);
    return { action: 'reply', reply: 'No pudimos identificar etapa, bloque y casa completos. Responde, por ejemplo: E1 B4 C18', paymentId: pending.paymentId, reason: 'invalid_home_reply' };
  }

  const homes = await store.listHomes();
  const known = homes.find((candidate) =>
    candidate.active
    && candidate.stage === home.stage
    && candidate.block === home.block
    && candidate.house === home.house,
  );
  if (!known) {
    await markMessage(store, messageId, 'text', 'processed', at);
    return { action: 'reply', reply: 'No encontramos esa vivienda activa. Verifica etapa, bloque y casa e inténtalo de nuevo.', paymentId: pending.paymentId, reason: 'home_not_found' };
  }

  const payment = await store.getPayment(pending.paymentId);
  if (!payment) {
    await store.clearPending(phone);
    await markMessage(store, messageId, 'text', 'rejected', at);
    return { action: 'reply', reply: 'No pudimos relacionar la respuesta con un comprobante pendiente. El caso quedó para revisión.', reason: 'pending_payment_missing' };
  }

  const allPayments = await store.listPayments();
  const period = assignServicePeriod(home, payment.transactionDate, allPayments, now, payment.id);
  const clearedReason = payment.reviewReason === 'receipt_home_not_in_master' ? undefined : payment.reviewReason;
  let updated: PaymentRecord = {
    ...payment,
    stage: home.stage,
    block: home.block,
    house: home.house,
    period,
    updatedAt: at,
    status: clearedReason ? 'EN_REVISION' : 'PENDIENTE_VERIFICACION',
    reviewReason: clearedReason,
  };

  if (hasPeriodConflict(updated, allPayments) && !updated.reviewReason) {
    updated = { ...updated, status: 'EN_REVISION', reviewReason: 'service_period_already_has_payment' };
  }

  await store.updatePayment(updated);
  await store.clearPending(phone);
  await markMessage(store, messageId, 'text', 'processed', at);

  const reply = updated.status === 'EN_REVISION'
    ? `✅ Vivienda identificada: Etapa ${home.stage}, Bloque ${home.block}, Casa ${home.house}. El comprobante continúa en revisión.`
    : `✅ Comprobante registrado para Etapa ${home.stage}, Bloque ${home.block}, Casa ${home.house}. Mes aplicado: ${periodLabel(updated.period)}. Estado: pendiente de verificación.`;
  return { action: 'reply', reply, paymentId: updated.id, status: updated.status };
}

export async function ignoreWhatsAppMessage(messageId: string, kind: ProcessedMessage['kind'], store: PaymentStore, at = new Date()): Promise<void> {
  if (await store.hasProcessedMessage(messageId)) return;
  await markMessage(store, messageId, kind, 'ignored', at.toISOString());
}
