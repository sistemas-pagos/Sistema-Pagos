/**
 * Procesa los mensajes que el webhook dejo en la cola (docs/PLAN.md, fase 1).
 *
 * El webhook solo anota y responde 200. Todo lo caro — bajar la imagen, OCR,
 * parser, guardar y contestarle al vecino — pasa aca, en una corrida de Actions
 * sin limite de tiempo de funcion serverless.
 *
 * Cada mensaje se toma con un UPDATE condicional, asi que dos corridas
 * simultaneas no lo procesan dos veces. Los errores permanentes cierran el
 * mensaje como RECHAZADO y avisan al vecino; los transitorios lo dejan para el
 * proximo intento (invariante 14).
 *
 * No imprime telefonos, E/B/C, montos ni referencias (invariante 12).
 */
import type { Client } from '@libsql/client';
import { env } from '../src/config/env.ts';
import { createReceiptRecognizer, type ReceiptRecognizer } from '../src/ocr/tesseract.ts';
import { maskIdentifier, safeLog } from '../src/security/logging.ts';
import { ignoreWhatsAppMessage, processHomeReply, processReceiptMessage } from '../src/services/payment-processor.ts';
import { getPaymentStore } from '../src/storage/index.ts';
import { contextosPorRecordar, marcarRecordado } from '../src/storage/mantenimiento.ts';
import { createTursoClient, tursoConfigFromEnv } from '../src/storage/turso-client.ts';
import { cerrarMensaje, mensajesPendientes, tomarMensaje, type MensajePendiente } from '../src/storage/turso.ts';
import { downloadWhatsAppMedia, sendWhatsAppText } from '../src/whatsapp/client.ts';

type Store = Awaited<ReturnType<typeof getPaymentStore>>;

/** Un error que no mejora reintentando: el mensaje se cierra y se le avisa al vecino. */
class PermanentError extends Error {
  constructor(readonly aviso: string, motivo: string) {
    super(motivo);
    this.name = 'PermanentError';
  }
}

const RESPUESTA_SIN_CONTEXTO = [
  'Para registrar tu pago envía la foto del comprobante.',
  'Si ya lo enviaste y te pedimos la vivienda, respondé con el formato E1 B4 C18',
  '(Etapa, Bloque y Casa).',
].join(' ');

async function procesarComprobante(
  mensaje: MensajePendiente,
  store: Store,
  recognizer: ReceiptRecognizer,
) {
  if (!mensaje.mediaId) throw new PermanentError(RESPUESTA_SIN_CONTEXTO, 'media_id_ausente');

  const media = await downloadWhatsAppMedia(mensaje.mediaId);
  const mimeType = media.mimeType;

  if (mensaje.tipo === 'document' && mimeType === 'application/pdf') {
    throw new PermanentError(
      'Por ahora el MVP procesa comprobantes en JPG o PNG. Envía una imagen del comprobante.',
      'pdf_no_soportado',
    );
  }

  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
    throw new PermanentError('Formato no admitido. Envía el comprobante como JPG o PNG.', 'formato_no_admitido');
  }

  if (media.size && media.size > env().MAX_RECEIPT_BYTES) {
    throw new PermanentError('El archivo es demasiado grande para procesarlo. Envía una imagen más liviana.', 'archivo_muy_grande');
  }

  return processReceiptMessage({
    messageId: mensaje.messageId,
    phone: mensaje.telefono,
    bytes: media.bytes,
    declaredMime: mimeType,
    kind: mensaje.tipo === 'document' ? 'document' : 'image',
  }, { store, ocr: (bytes) => recognizer.recognize(bytes) });
}

async function procesarTexto(mensaje: MensajePendiente, store: Store) {
  const cuerpo = mensaje.cuerpo?.trim();
  if (!cuerpo) {
    await ignoreWhatsAppMessage(mensaje.messageId, 'other', store);
    return { action: 'silent' as const };
  }

  const resultado = await processHomeReply(mensaje.messageId, mensaje.telefono, cuerpo, { store });
  // Un texto que no responde a ningun comprobante pendiente recibe instrucciones.
  if (resultado.action === 'silent' && resultado.reason === 'no_pending_receipt') {
    return { action: 'reply' as const, reply: RESPUESTA_SIN_CONTEXTO };
  }
  return resultado;
}

async function responder(telefono: string, texto: string, messageId: string): Promise<boolean> {
  try {
    await sendWhatsAppText(telefono, texto);
    return true;
  } catch (error) {
    safeLog('error', 'whatsapp_reply_send_failed', {
      messageId: maskIdentifier(messageId),
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return false;
  }
}

const RECORDATORIO_VIVIENDA = [
  'Todavía nos falta saber de qué casa es tu pago.',
  'Respondé con tu Etapa, Bloque y Casa, por ejemplo E1 B4 C18.',
].join(' ');

/**
 * Un solo recordatorio a quien no contesto de que casa es su pago.
 *
 * Va antes de procesar los mensajes y no despues: en una corrida sin mensajes
 * nuevos —que es la mayoria— el worker sale temprano, y ahi es justamente
 * cuando hace falta recordar.
 *
 * Sigue dentro de la ventana de 24 horas de WhatsApp, asi que es texto libre y
 * no necesita plantilla aprobada. Uno solo: la marca en la base impide que las
 * corridas siguientes lo repitan.
 */
async function recordarVivienda(db: Client): Promise<number> {
  const ahora = new Date().toISOString();
  const pendientes = await contextosPorRecordar(db, ahora);
  let enviados = 0;

  for (const contexto of pendientes) {
    if (await responder(contexto.telefono, RECORDATORIO_VIVIENDA, contexto.id)) {
      await marcarRecordado(db, contexto.id, ahora);
      enviados += 1;
    }
  }

  return enviados;
}

async function main(): Promise<void> {
  const db = await createTursoClient(tursoConfigFromEnv());
  let recognizer: ReceiptRecognizer | undefined;

  try {
    const recordados = await recordarVivienda(db);
    if (recordados > 0) safeLog('info', 'recordatorio_vivienda_enviado', { cantidad: recordados });

    const pendientes = await mensajesPendientes(db);
    if (pendientes.length === 0) {
      safeLog('info', 'procesar_comprobantes_sin_pendientes');
      return;
    }

    safeLog('info', 'procesar_comprobantes_inicio', { pendientes: pendientes.length });
    const store = await getPaymentStore();
    let procesados = 0;
    let rechazados = 0;
    let fallidos = 0;

    for (const mensaje of pendientes) {
      const ahora = new Date().toISOString();
      // Si otra corrida ya lo cerro, este UPDATE no afecta filas y lo salteamos.
      if (!await tomarMensaje(db, mensaje.messageId, ahora)) continue;

      try {
        let resultado;
        if (mensaje.tipo === 'text') {
          resultado = await procesarTexto(mensaje, store);
        } else {
          // El worker de Tesseract se arranca una sola vez, al primer comprobante.
          recognizer ??= await createReceiptRecognizer();
          resultado = await procesarComprobante(mensaje, store, recognizer);
        }

        if (resultado.action === 'reply' && resultado.reply) {
          await responder(mensaje.telefono, resultado.reply, mensaje.messageId);
        }

        await cerrarMensaje(db, {
          messageId: mensaje.messageId,
          estado: 'PROCESADO',
          actualizadoEn: new Date().toISOString(),
        });
        procesados += 1;
      } catch (error) {
        if (error instanceof PermanentError) {
          await responder(mensaje.telefono, error.aviso, mensaje.messageId);
          await cerrarMensaje(db, {
            messageId: mensaje.messageId,
            estado: 'RECHAZADO',
            error: error.message,
            actualizadoEn: new Date().toISOString(),
          });
          rechazados += 1;
          continue;
        }

        // Transitorio: queda en PROCESANDO con un intento mas y lo retoma la
        // proxima corrida, hasta agotar el limite de intentos.
        fallidos += 1;
        safeLog('error', 'procesar_comprobante_fallido', {
          messageId: maskIdentifier(mensaje.messageId),
          intentos: mensaje.intentos + 1,
          reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
        });
      }
    }

    safeLog('info', 'procesar_comprobantes_fin', { procesados, rechazados, fallidos });
  } finally {
    await recognizer?.close();
    db.close();
  }
}

main().catch((error: unknown) => {
  safeLog('error', 'procesar_comprobantes_error', {
    reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
  });
  process.exitCode = 1;
});
