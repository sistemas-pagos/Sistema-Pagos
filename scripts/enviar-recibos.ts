/**
 * Vacia la cola de envios: manda por WhatsApp los recibos que estan esperando
 * (docs/PLAN.md, fase 4).
 *
 * Va aparte de la emision a proposito. El recibo se emite en la misma
 * transaccion que la verificacion, donde nada externo puede fallar; mandarlo
 * por WhatsApp depende de una red y de Meta, y eso si falla. Si el envio
 * viviera dentro de esa transaccion, un timeout de Meta desharia una
 * verificacion buena.
 *
 * Reintenta desde la cola, no reemitiendo: un reenvio lleva el mismo numero de
 * recibo. Emitir uno nuevo para reintentar seria quemar un numero de la
 * secuencia cada vez que se cae la red (invariante 10).
 *
 * No imprime telefonos, E/B/C, montos ni referencias (invariante 12): solo
 * contadores y el numero de recibo, que no identifica a nadie por si solo.
 */
import { env } from '../src/config/env.ts';
import { parametrosDePlantilla } from '../src/domain/recibo.ts';
import { safeLog } from '../src/security/logging.ts';
import { createTursoClient, tursoConfigFromEnv } from '../src/storage/turso-client.ts';
import { enviosPendientes, marcarEnvioEnviado, marcarEnvioFallido } from '../src/storage/turso.ts';
import { sendWhatsAppTemplate, WhatsAppSendError } from '../src/whatsapp/client.ts';

/** Tras cinco intentos el envio queda FALLIDO y sale de la cola. */
const MAX_INTENTOS = 5;

async function main(): Promise<void> {
  const db = await createTursoClient(tursoConfigFromEnv());

  try {
    const pendientes = await enviosPendientes(db, MAX_INTENTOS);
    if (pendientes.length === 0) {
      safeLog('info', 'enviar_recibos_sin_pendientes');
      return;
    }

    safeLog('info', 'enviar_recibos_inicio', { pendientes: pendientes.length });
    const idioma = env().WHATSAPP_TEMPLATE_IDIOMA;
    let enviados = 0;
    let fallidos = 0;

    for (const envio of pendientes) {
      const ahora = new Date().toISOString();
      try {
        const waMessageId = await sendWhatsAppTemplate(
          envio.telefono,
          envio.plantilla,
          parametrosDePlantilla({
            numero: envio.reciboNumero,
            vivienda: envio.vivienda,
            periodos: envio.periodos,
            montoCentavos: envio.montoCentavos,
            metodo: envio.metodo,
            referencia: envio.referencia,
            fechaPago: envio.fechaPago,
            verificadoEn: envio.verificadoEn,
          }),
          idioma,
        );

        await marcarEnvioEnviado(db, { id: envio.id, waMessageId, en: ahora });
        enviados += 1;
      } catch (error) {
        const permanente = error instanceof WhatsAppSendError && error.permanente;
        const motivo = error instanceof Error ? error.message : 'unknown';

        await marcarEnvioFallido(db, {
          id: envio.id,
          error: motivo,
          en: ahora,
          // Un error permanente no mejora reintentando: se agota la cuenta de
          // intentos de una vez y el recibo queda listado como no entregado.
          maxIntentos: permanente ? envio.intentos + 1 : MAX_INTENTOS,
        });

        fallidos += 1;
        safeLog('warn', 'enviar_recibo_fallido', {
          recibo: envio.reciboNumero,
          intentos: envio.intentos + 1,
          permanente,
          reason: motivo.slice(0, 60),
        });
      }
    }

    safeLog('info', 'enviar_recibos_fin', { enviados, fallidos });
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  safeLog('error', 'enviar_recibos_error', {
    reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
  });
  process.exitCode = 1;
});
