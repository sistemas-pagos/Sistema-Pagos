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
import { env } from '../src/config/env.ts';
import { createReceiptRecognizer, type ReceiptRecognizer } from '../src/ocr/tesseract.ts';
import { maskIdentifier, safeLog } from '../src/security/logging.ts';
import { ignoreWhatsAppMessage, processHomeReply, processReceiptMessage } from '../src/services/payment-processor.ts';
import { getPaymentStore } from '../src/storage/index.ts';
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

/**
 * Lo primero que lee un vecino que escribe sin haber mandado nada.
 *
 * Una sola cosa que hacer. La version anterior explicaba ademas que responder
 * "si ya lo enviaste y te pedimos la vivienda", que es una instruccion para un
 * momento distinto: quien apenas saluda todavia no envio nada, y el formato de
 * la vivienda se le explica cuando de verdad se le pregunta.
 *
 * No dice "foto" a proposito: el comprobante casi siempre es una captura de la
 * app del banco, no una fotografia de un papel. Nombrar el medio equivocado
 * hace dudar a quien tiene justo lo que hay que mandar.
 */
const SALUDO = '¡Hola! Enviá tu comprobante de depósito para registrarlo.';

/**
 * El mensaje venia como imagen o documento pero sin archivo que descargar.
 * Aca no se saluda: el vecino ya mando algo y lo que necesita saber es que no
 * llego, no un instructivo desde cero.
 */
const SIN_ARCHIVO = 'No pudimos abrir esa imagen. Volvé a enviar tu comprobante.';

async function procesarComprobante(
  mensaje: MensajePendiente,
  store: Store,
  recognizer: ReceiptRecognizer,
) {
  if (!mensaje.mediaId) throw new PermanentError(SIN_ARCHIVO, 'media_id_ausente');

  const media = await downloadWhatsAppMedia(mensaje.mediaId);
  const mimeType = media.mimeType;

  if (mensaje.tipo === 'document' && mimeType === 'application/pdf') {
    throw new PermanentError(
      'Por ahora solo podemos leer imágenes. Enviá una captura del comprobante en vez del PDF.',
      'pdf_no_soportado',
    );
  }

  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
    throw new PermanentError('No pudimos leer ese archivo. Enviá el comprobante como imagen.', 'formato_no_admitido');
  }

  if (media.size && media.size > env().MAX_RECEIPT_BYTES) {
    throw new PermanentError('Esa imagen pesa demasiado para procesarla. Enviá una más liviana.', 'archivo_muy_grande');
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
    return { action: 'reply' as const, reply: SALUDO };
  }
  return resultado;
}

async function responder(telefono: string, texto: string, messageId: string): Promise<void> {
  try {
    await sendWhatsAppText(telefono, texto);
  } catch (error) {
    safeLog('error', 'whatsapp_reply_send_failed', {
      messageId: maskIdentifier(messageId),
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }
}

async function main(): Promise<void> {
  const db = await createTursoClient(tursoConfigFromEnv());
  let recognizer: ReceiptRecognizer | undefined;

  try {
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
