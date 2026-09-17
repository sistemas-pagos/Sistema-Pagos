import { createHash } from 'node:crypto';
import { env } from '@/src/config/env';
import { decideDuplicate } from '@/src/domain/duplicates';
import { parseHomeReference } from '@/src/domain/housing';
import { periodLabel } from '@/src/domain/periods';
import { samePhone } from '@/src/domain/phone';
import type { HomeRecord, HomeRef, PaymentRecord, PendingConversation, ProcessedMessage } from '@/src/domain/types';
import { recognizeReceipt } from '@/src/ocr/tesseract';
import { detectAndParseReceipt } from '@/src/parsers';
import { validateReceiptFile } from '@/src/security/files';
import type { PaymentStore } from '@/src/storage/types';
import { assignServicePeriod, depositServicePeriod, hasPeriodConflict } from './period-assignment';
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

/**
 * Debajo de esta confianza el texto del OCR no sirve para nada: los campos
 * salen a medias o inventados. Es el mismo umbral con el que `validation`
 * mandaba el pago a revision; la diferencia es que ahora se pide otra foto.
 */
const CONFIANZA_MINIMA_OCR = 0.55;

/**
 * Respuestas de vivienda que no sirvieron antes de pasar el caso a una persona.
 *
 * Tres es suficiente para un error de tipeo y poco para que el vecino sienta
 * que el bot no lo entiende. Sin limite, alguien que no sabe su etapa recibe la
 * misma pregunta indefinidamente y el pago no avanza nunca.
 */
const MAX_INTENTOS_VIVIENDA = 3;

/**
 * La foto no se puede leer.
 *
 * Se pide otra en vez de mandar el caso a revision porque las imagenes no se
 * guardan (invariante 11): quien revisara despues tampoco podria verla. Y se
 * pide ahora, no manana, porque el vecino todavia tiene el comprobante a mano.
 *
 * El mensaje dice que no quedo registrado nada. Callarlo dejaria a alguien
 * creyendo que ya pago.
 */
function fotoIlegibleReply(motivo = 'No logramos leer el comprobante.'): string {
  return [
    `📸 ${motivo} No quedó registrado ningún pago.`,
    'Volvé a tomar la foto de cerca, con buena luz, y que se lean el monto y el número de referencia.',
  ].join('\n');
}

function noEsComprobanteReply(): string {
  return [
    'No reconocimos un comprobante de pago en esa imagen. No se registró ningún pago.',
    'Si es un comprobante del banco, enviá la captura completa, sin recortar los bordes.',
  ].join('\n');
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
    `Recibimos tu comprobante por ${amountLabel(payment.amount)}, pero falta saber de qué vivienda es.`,
    'Respondé con etapa, bloque y casa. Por ejemplo: E1 B4 C18',
    'También sirve escribirlo: "etapa 1, bloque 4, casa 18".',
  ].join('\n');
}

/**
 * Se repite el ejemplo en cada intento en vez de reprochar. Quien contesta mal
 * dos veces no esta siendo descuidado: no entendio que le estan pidiendo.
 */
function viviendaNoEntendidaReply(intento: number): string {
  const restantes = MAX_INTENTOS_VIVIENDA - intento;
  const cierre = restantes === 1
    ? 'Si no sale esta vez, lo revisa una persona.'
    : 'Escribí solo la vivienda, sin el nombre ni el mes.';
  return [
    'No logramos identificar la vivienda.',
    'Necesitamos las tres cosas: etapa, bloque y casa. Por ejemplo: E1 B4 C18',
    cierre,
  ].join('\n');
}

function viviendaDesconocidaReply(intento: number): string {
  const restantes = MAX_INTENTOS_VIVIENDA - intento;
  return [
    'Esa vivienda no aparece en el padrón.',
    'Revisá la etapa, el bloque y la casa.',
    restantes === 1 ? 'Si no sale esta vez, lo revisa una persona.' : 'Por ejemplo: E1 B4 C18',
  ].join('\n');
}

function aRevisionHumanaReply(): string {
  return [
    'No pudimos identificar la vivienda, así que lo va a revisar una persona.',
    'Tu comprobante está guardado: no hace falta que lo envíes de nuevo.',
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

async function resolveHome(store: PaymentStore, parsedHome: HomeRef | undefined): Promise<{ home?: HomeRecord; warning?: string }> {
  if (!parsedHome) return {};
  const homes = await store.listHomes();
  // Se devuelve la ficha del padron, no solo la referencia: la fecha de alta
  // decide desde que mes se le cobra a esta vivienda (invariante 5).
  const match = homes.find((home) =>
    home.active
    && home.stage === parsedHome.stage
    && home.block === parsedHome.block
    && home.house === parsedHome.house,
  );
  if (match) return { home: match };
  return { warning: 'receipt_home_not_in_master' };
}

export async function processReceiptMessage(input: ReceiptMessageInput, deps: ProcessorDependencies): Promise<ProcessOutcome> {
  const { store } = deps;
  // La idempotencia vive en la tabla `mensajes` de Turso, cuya clave primaria es
  // el message_id: el webhook la inserta antes de encolar nada, y el worker toma
  // cada mensaje una sola vez. Ya no hace falta un Set en memoria, que ademas no
  // servia con varias instancias (docs/PLAN.md, fase 1).
  if (await store.hasProcessedMessage(input.messageId)) return { action: 'silent', reason: 'technical_retry' };

  {
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
      return { action: 'reply', reply: fotoIlegibleReply(), reason: 'ocr_failed' };
    }

    // Una foto que no se puede leer no se manda a revision humana: las imagenes
    // no se guardan (invariante 11), asi que quien la revisara despues tampoco
    // podria leerla. Lo unico util es pedir otra ahora, mientras el vecino tiene
    // el comprobante en la mano; en diez minutos ya no lo tiene.
    if (ocrConfidence > 0 && ocrConfidence < CONFIANZA_MINIMA_OCR) {
      await markMessage(store, input.messageId, kind, 'processed', at);
      return { action: 'reply', reply: fotoIlegibleReply(), reason: 'ocr_low_confidence' };
    }

    let extraction;
    try {
      extraction = detectAndParseReceipt(text);
      extraction.confidence = Math.min(extraction.confidence, ocrConfidence || extraction.confidence);
    } catch {
      await markMessage(store, input.messageId, kind, 'rejected', at);
      return { action: 'reply', reply: noEsComprobanteReply(), reason: 'unsupported_receipt' };
    }

    // El monto es el unico dato sin el que no hay pago posible. Que no se lea
    // suele ser la foto, no el comprobante, asi que se pide otra.
    if (!extraction.amount || extraction.amount <= 0) {
      await markMessage(store, input.messageId, kind, 'processed', at);
      return { action: 'reply', reply: fotoIlegibleReply('No pudimos leer el monto.'), reason: 'amount_missing' };
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
      : depositServicePeriod(extraction.transactionDate, now);

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
        attempts: 0,
      };
      await store.savePending(pending);
    }

    await markMessage(store, input.messageId, kind, 'processed', at);

    if (shouldAskHome) return { action: 'reply', reply: unidentifiedReply(record), paymentId: record.id, status: record.status, reason: reviewReason };
    if (pendingConflict || record.status === 'EN_REVISION') return { action: 'reply', reply: reviewReply(), paymentId: record.id, status: record.status, reason: record.reviewReason };
    return { action: 'reply', reply: receiptAcceptedReply(record), paymentId: record.id, status: record.status };
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
    return respuestaQueNoSirvio(store, pending, messageId, at, 'invalid_home_reply', viviendaNoEntendidaReply);
  }

  const homes = await store.listHomes();
  const known = homes.find((candidate) =>
    candidate.active
    && candidate.stage === home.stage
    && candidate.block === home.block
    && candidate.house === home.house,
  );
  if (!known) {
    return respuestaQueNoSirvio(store, pending, messageId, at, 'home_not_found', viviendaDesconocidaReply);
  }

  const payment = await store.getPayment(pending.paymentId);
  if (!payment) {
    await store.clearPending(phone);
    await markMessage(store, messageId, 'text', 'rejected', at);
    return { action: 'reply', reply: 'No pudimos relacionar la respuesta con un comprobante pendiente. El caso quedó para revisión.', reason: 'pending_payment_missing' };
  }

  const allPayments = await store.listPayments();
  // `known` es la ficha del padron: trae la fecha de alta de la vivienda.
  const period = assignServicePeriod(known, payment.transactionDate, allPayments, now, payment.id);
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

/**
 * Cuenta una respuesta que no sirvio y decide si vale la pena volver a preguntar.
 *
 * Al agotar los intentos el pago pasa a revision humana en vez de quedarse en
 * ESPERANDO_RESPUESTA para siempre: ahi el dinero ya entro al banco y alguien
 * tiene que decidir de quien es, cosa que el bot ya demostro que no puede.
 */
async function respuestaQueNoSirvio(
  store: PaymentStore,
  pending: PendingConversation,
  messageId: string,
  at: string,
  reason: string,
  mensaje: (intento: number) => string,
): Promise<ProcessOutcome> {
  const intentos = pending.attempts + 1;
  await markMessage(store, messageId, 'text', 'processed', at);

  if (intentos < MAX_INTENTOS_VIVIENDA) {
    await store.savePending({ ...pending, attempts: intentos });
    return { action: 'reply', reply: mensaje(intentos), paymentId: pending.paymentId, reason };
  }

  await store.clearPending(pending.phone);
  const payment = await store.getPayment(pending.paymentId);
  if (payment) {
    await store.updatePayment({
      ...payment,
      status: 'EN_REVISION',
      reviewReason: 'home_reply_attempts_exhausted',
      updatedAt: at,
    });
  }

  return {
    action: 'reply',
    reply: aRevisionHumanaReply(),
    paymentId: pending.paymentId,
    status: 'EN_REVISION',
    reason: 'home_reply_attempts_exhausted',
  };
}

export async function ignoreWhatsAppMessage(messageId: string, kind: ProcessedMessage['kind'], store: PaymentStore, at = new Date()): Promise<void> {
  if (await store.hasProcessedMessage(messageId)) return;
  await markMessage(store, messageId, kind, 'ignored', at.toISOString());
}
