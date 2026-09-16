import { ZodError } from 'zod';
import { isDemoMode, requireProductionEnv } from '@/src/config/env';
import { maskIdentifier, safeLog } from '@/src/security/logging';
import { getTursoClient } from '@/src/storage/turso-client';
import { registrarMensaje } from '@/src/storage/turso';
import { requestReceiptProcessing } from '@/src/whatsapp/dispatch';
import { extractIncomingMessages, type IncomingWhatsAppMessage } from '@/src/whatsapp/payload';
import { verifyMetaSignature, verifyWebhookChallenge } from '@/src/whatsapp/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (isDemoMode()) return new Response('Not found', { status: 404 });
  const token = requireProductionEnv('WHATSAPP_VERIFY_TOKEN').WHATSAPP_VERIFY_TOKEN;
  const challenge = verifyWebhookChallenge(new URL(request.url).searchParams, token);
  if (!challenge) return new Response('Forbidden', { status: 403 });
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * El webhook solo anota lo que llego y avisa a Actions (docs/PLAN.md, seccion 2).
 * No descarga la imagen, no hace OCR y no crea pagos: eso corre despues, fuera
 * del limite de tiempo de la funcion y sin hacer esperar a Meta.
 *
 * El INSERT en `mensajes` va primero. Su clave primaria es el `message_id`, asi
 * que un reintento de Meta no crea un segundo registro y, como el pago cuelga de
 * ese mensaje, tampoco puede crear un segundo pago (invariante 14).
 */
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

  let nuevos = 0;

  try {
    const db = await getTursoClient();

    for (const message of messages) {
      const created = await registrarMensaje(db, {
        messageId: message.messageId,
        telefono: message.phone,
        tipo: message.kind,
        mediaId: message.kind === 'image' || message.kind === 'document' ? message.mediaId : undefined,
        cuerpo: message.kind === 'text' ? message.body : undefined,
        // 'other' no se procesa: se cierra aqui mismo y nadie lo vuelve a mirar.
        estado: message.kind === 'other' ? 'IGNORADO' : 'RECIBIDO',
        recibidoEn: new Date().toISOString(),
      });

      if (!created) {
        safeLog('info', 'whatsapp_message_duplicate', { messageId: maskIdentifier(message.messageId) });
        continue;
      }

      if (message.kind !== 'other') nuevos += 1;
    }
  } catch (error) {
    // Una base caida es transitorio: aqui si conviene que Meta reintente.
    safeLog('error', 'whatsapp_intake_failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return new Response('Retry required', { status: 500 });
  }

  if (nuevos > 0) {
    // Si el aviso falla no pasa nada: el workflow tambien corre por cron.
    await requestReceiptProcessing();
    safeLog('info', 'whatsapp_intake_queued', { count: nuevos });
  }

  return new Response('EVENT_RECEIVED', { status: 200 });
}
