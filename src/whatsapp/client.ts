import { env, requireProductionEnv } from '@/src/config/env';

interface MediaMetadata {
  id: string;
  url: string;
  mime_type?: string;
  file_size?: number;
  sha256?: string;
}

function graphUrl(version: string, path: string): string {
  return `https://graph.facebook.com/${version}/${path}`;
}

function bearerHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function exceedsLimit(value: number | undefined, limit: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > limit;
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType?: string; size?: number }> {
  const config = requireProductionEnv('WHATSAPP_ACCESS_TOKEN');
  const runtimeEnv = env();
  const version = runtimeEnv.WHATSAPP_GRAPH_VERSION;
  const maxBytes = runtimeEnv.MAX_RECEIPT_BYTES;
  const metadataResponse = await fetch(graphUrl(version, encodeURIComponent(mediaId)), {
    headers: bearerHeaders(config.WHATSAPP_ACCESS_TOKEN),
    cache: 'no-store',
  });
  if (!metadataResponse.ok) throw new Error(`whatsapp_media_metadata_failed:${metadataResponse.status}`);
  const metadata = await metadataResponse.json() as MediaMetadata;
  if (!metadata.url || metadata.id !== mediaId) throw new Error('whatsapp_media_metadata_invalid');
  if (exceedsLimit(metadata.file_size, maxBytes)) throw new Error('receipt_file_too_large');

  const mediaResponse = await fetch(metadata.url, {
    headers: bearerHeaders(config.WHATSAPP_ACCESS_TOKEN),
    cache: 'no-store',
    redirect: 'follow',
  });
  if (!mediaResponse.ok) throw new Error(`whatsapp_media_download_failed:${mediaResponse.status}`);
  const contentLength = Number.parseInt(mediaResponse.headers.get('content-length') ?? '', 10);
  if (exceedsLimit(Number.isFinite(contentLength) ? contentLength : undefined, maxBytes)) {
    throw new Error('receipt_file_too_large');
  }

  const bytes = Buffer.from(await mediaResponse.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('receipt_file_too_large');
  return {
    bytes,
    mimeType: mediaResponse.headers.get('content-type')?.split(';')[0] || metadata.mime_type,
    size: metadata.file_size ?? bytes.length,
  };
}

export async function sendWhatsAppText(phone: string, body: string): Promise<void> {
  const config = requireProductionEnv('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID');
  const version = env().WHATSAPP_GRAPH_VERSION;
  const response = await fetch(graphUrl(version, `${encodeURIComponent(config.WHATSAPP_PHONE_NUMBER_ID)}/messages`), {
    method: 'POST',
    headers: {
      ...bearerHeaders(config.WHATSAPP_ACCESS_TOKEN),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { preview_url: false, body },
    }),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`whatsapp_send_failed:${response.status}`);
}

/**
 * Envia una plantilla aprobada y devuelve el identificador que asigna Meta.
 *
 * Un recibo puede salir horas despues de que el vecino escribio, asi que cae
 * fuera de la ventana de 24 h y un mensaje de texto libre seria rechazado
 * (invariante 13). La plantilla es lo unico que Meta acepta ahi, y su texto se
 * aprueba antes: aqui solo viajan los parametros que rellenan los {{n}}.
 *
 * Distingue el fallo permanente del transitorio. Un 4xx que no sea 429 no
 * mejora reintentando —la plantilla no existe, el numero es invalido— y se
 * marca como tal para que la cola no lo reintente cinco veces.
 */
export class WhatsAppSendError extends Error {
  readonly permanente: boolean;

  constructor(mensaje: string, permanente: boolean) {
    super(mensaje);
    this.name = 'WhatsAppSendError';
    this.permanente = permanente;
  }
}

export async function sendWhatsAppTemplate(
  phone: string,
  plantilla: string,
  parametros: string[],
  idioma = 'es',
): Promise<string | undefined> {
  const config = requireProductionEnv('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID');
  const version = env().WHATSAPP_GRAPH_VERSION;

  const response = await fetch(graphUrl(version, `${encodeURIComponent(config.WHATSAPP_PHONE_NUMBER_ID)}/messages`), {
    method: 'POST',
    headers: { ...bearerHeaders(config.WHATSAPP_ACCESS_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: plantilla,
        language: { code: idioma },
        components: [{
          type: 'body',
          parameters: parametros.map((text) => ({ type: 'text', text })),
        }],
      },
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const permanente = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new WhatsAppSendError(`whatsapp_template_failed:${response.status}`, permanente);
  }

  const cuerpo = await response.json() as { messages?: { id?: string }[] };
  return cuerpo.messages?.[0]?.id;
}
