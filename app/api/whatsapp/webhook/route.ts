import { ZodError } from 'zod';
import { env, isDemoMode, requireProductionEnv } from '@/src/config/env';
import { maskIdentifier, maskPhone, safeLog } from '@/src/security/logging';
import { ignoreWhatsAppMessage, processHomeReply, processReceiptMessage } from '@/src/services/payment-processor';
import { getPaymentStore } from '@/src/storage';
import { downloadWhatsAppMedia, sendWhatsAppText } from '@/src/whatsapp/client';
import { extractIncomingMessages, type IncomingWhatsAppMessage } from '@/src/whatsapp/payload';
import { verifyMetaSignature, verifyWebhookChallenge } from '@/src/whatsapp/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  if (isDemoMode()) return new Response('Not found', { status: 404 });
  const token = requireProductionEnv('WHATSAPP_VERIFY_TOKEN').WHATSAPP_VERIFY_TOKEN;
  const challenge = verifyWebhookChallenge(new URL(request.url).searchParams, token);
  if (!challenge) return new Response('Forbidden', { status: 403 });
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

export async function POST(request: Request) {
  if (isDemoMode()) return new Response('Not found', { status: 404 });
  const rawBody = await request.text();
  const appSecret = requireProductionEnv('META_APP_SECRET').META_APP_SECRET;
  if (!verifyMetaSignature(rawBody, request.headers.get('x-hub-signature-256'), appSecret)) {
    safeLog('warn', 'whatsapp_webhook_signature_rejected');
    return new Response('Unauthorized', { status: 401 });
  }

  let messages: IncomingWhatsAppMessage[];
  try {
    messages = extractIncomingMessages(JSON.parse(rawBody) as unknown);
  } catch (error) {
    safeLog('warn', 'whatsapp_webhook_payload_rejected', { reason: error instanceof ZodError ? 'schema' : 'json' });
    return new Response('Bad request', { status: 400 });
  }

  const store = await getPaymentStore();
  let shouldRetry = false;

  for (const message of messages) {
    try {
      const outcome = await handleMessage(message, store);
      if (outcome?.reply) {
        try {
          await sendWhatsAppText(message.phone, outcome.reply);
        } catch (error) {
          safeLog('error', 'whatsapp_reply_send_failed', {
            phone: maskPhone(message.phone),
            messageId: maskIdentifier(message.messageId),
            reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
          });
        }
      }
    } catch (error) {
      shouldRetry = true;
      safeLog('error', 'whatsapp_message_processing_failed', {
        phone: maskPhone(message.phone),
        messageId: maskIdentifier(message.messageId),
        kind: message.kind,
        reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    }
  }

  return new Response(shouldRetry ? 'Retry required' : 'EVENT_RECEIVED', { status: shouldRetry ? 500 : 200 });
}

async function handleMessage(
  message: IncomingWhatsAppMessage,
  store: Awaited<ReturnType<typeof getPaymentStore>>,
) {
  // Meta can retry the exact same webhook delivery. Short-circuit before media
  // download/OCR so a technical retry is silent and cannot create a second payment.
  if (await store.hasProcessedMessage(message.messageId)) {
    return { action: 'silent' as const };
  }

  if (message.kind === 'text') {
    return processHomeReply(message.messageId, message.phone, message.body, { store });
  }

  if (message.kind === 'other') {
    await ignoreWhatsAppMessage(message.messageId, 'other', store);
    return { action: 'silent' as const };
  }

  // Media bytes exist only for this request: validate, hash and OCR them, then discard.
  const media = await downloadWhatsAppMedia(message.mediaId);
  const mimeType = media.mimeType ?? message.declaredMime;
  if (message.declaredMime && mimeType && message.declaredMime !== mimeType) {
    await ignoreWhatsAppMessage(message.messageId, message.kind, store);
    return { action: 'reply' as const, reply: 'El archivo recibido no coincide con el formato declarado. No se registró ningún pago.' };
  }

  if (message.kind === 'document' && mimeType === 'application/pdf') {
    await ignoreWhatsAppMessage(message.messageId, 'document', store);
    return { action: 'reply' as const, reply: 'Por ahora el MVP procesa comprobantes en JPG o PNG. Envía una imagen del comprobante.' };
  }

  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
    await ignoreWhatsAppMessage(message.messageId, message.kind, store);
    return { action: 'reply' as const, reply: 'Formato no admitido. Envía el comprobante como JPG o PNG.' };
  }

  if (media.size && media.size > env().MAX_RECEIPT_BYTES) {
    await ignoreWhatsAppMessage(message.messageId, message.kind, store);
    return { action: 'reply' as const, reply: 'El archivo es demasiado grande para procesarlo. Envía una imagen más liviana.' };
  }

  return processReceiptMessage({
    messageId: message.messageId,
    phone: message.phone,
    bytes: media.bytes,
    declaredMime: mimeType,
    kind: message.kind,
  }, { store });
}
