import { randomUUID } from 'node:crypto';
import {
  ExtractoInvalidoError,
  depositosRecibidos,
  huellaDelArchivo,
  leerExtractoBac,
  ultimos4DeLaCuenta,
} from '@/src/bank/bac-csv';
import { env } from '@/src/config/env';
import { resumirConciliacion, textoDelResumen } from '@/src/domain/resumen-conciliacion';
import { type BankMovement, planReconciliation, reconcilePendingPayments } from '@/src/services/reconciliation';
import {
  cerrarImportacion,
  importacionPendienteDe,
  movimientosDeBanco,
  registrarImportacion,
} from '@/src/storage/conciliacion';
import type { Db } from '@/src/storage/turso';
import type { PaymentStore } from '@/src/storage/types';
import type { Usuario } from '@/src/storage/usuarios';

/**
 * El hilo completo de la conciliacion por WhatsApp: llega el extracto, se
 * resume, el tesorero responde SI y recien ahi se verifica.
 *
 * Vive fuera del worker para poder probarse sin red ni WhatsApp: lo que importa
 * de este archivo no es que hable con Meta, sino que **lo que se aplica sea
 * exactamente lo que se mostro**.
 */

export interface ConciliacionDeps {
  db: Db;
  store: PaymentStore;
  ahora?: () => Date;
}

const ORIGEN = 'extracto-bac';

function horaLegible(fecha: Date): string {
  return fecha.toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Tegucigalpa' });
}

const NO_CUADRA = 'Ese archivo no cuadra: los saldos no suman. Volvé a descargarlo del banco sin modificarlo.';
const OTRA_CUENTA = 'Ese extracto no es de la cuenta de cobro. Revisá que sea la cuenta correcta.';
const YA_ESTABA = 'Ese archivo ya lo habías mandado. Si querés aplicarlo, respondé SI al resumen anterior.';
const NADA_ESPERANDO = 'No hay ningún extracto esperando confirmación.';
const YA_NO_VALE = 'Esa confirmación ya venció o el extracto ya se aplicó. Mandá el archivo de nuevo.';

/**
 * Que hacer con un documento que mando alguien autorizado.
 *
 * `no_es_extracto` significa "esto no era para mi": el tesorero tambien es
 * vecino y puede estar mandando su propio comprobante, asi que el mensaje
 * sigue por el camino de siempre en vez de recibir un reproche.
 */
export type ResultadoExtracto =
  | { tipo: 'respuesta'; respuesta: string }
  | { tipo: 'no_es_extracto' };

/**
 * Lee el extracto, lo guarda y devuelve el resumen para que una persona
 * confirme. **No verifica nada todavia.**
 *
 * El resumen se calcula contra todos los movimientos que la base va a conocer
 * —los que ya tenia mas los de este archivo—, que es el mismo conjunto contra
 * el que se aplicara despues. Si se calculara solo con los del archivo, el
 * resumen diria una cosa y el "SI" haria otra.
 */
export async function recibirExtracto(
  deps: ConciliacionDeps,
  usuario: Usuario,
  bytes: Buffer,
): Promise<ResultadoExtracto> {
  const ahora = deps.ahora?.() ?? new Date();

  let extracto;
  try {
    extracto = leerExtractoBac(bytes);
  } catch (error) {
    if (!(error instanceof ExtractoInvalidoError)) throw error;
    // Que no cuadre es distinto de que no sea un extracto: el archivo si era
    // el del banco, y el tesorero tiene que enterarse en vez de que se lo
    // traten como un comprobante cualquiera.
    return error.motivo === 'balance_no_cuadra'
      ? { tipo: 'respuesta', respuesta: NO_CUADRA }
      : { tipo: 'no_es_extracto' };
  }

  const esperada = env().EXPECTED_ACCOUNT_LAST4;
  if (esperada && ultimos4DeLaCuenta(extracto) !== esperada) return { tipo: 'respuesta', respuesta: OTRA_CUENTA };

  const nuevos = depositosRecibidos(extracto);
  const conocidos = await movimientosDeBanco(deps.db);
  const todos = unirPorId(conocidos, nuevos);

  const plan = planReconciliation(await deps.store.listPayments(), todos);
  const resumen = resumirConciliacion(plan, todos);

  const expiraEn = new Date(ahora.getTime() + env().PAGOS_CONFIRMACION_MINUTOS * 60_000);
  const importacion = await registrarImportacion(deps.db, {
    id: randomUUID(),
    subidoPor: usuario.id,
    archivoSha256: huellaDelArchivo(bytes),
    movimientos: extracto.movimientos
      .filter((movimiento) => movimiento.creditoCentavos > 0)
      .map((movimiento) => ({
        huella: movimiento.huella,
        fecha: movimiento.fecha,
        referencia: movimiento.referencia,
        descripcion: movimiento.descripcion,
        montoCentavos: movimiento.creditoCentavos,
      })),
    resumen,
    expiraEn: expiraEn.toISOString(),
    creadoEn: ahora.toISOString(),
  }, usuario.id);

  if (!importacion.registrada) return { tipo: 'respuesta', respuesta: YA_ESTABA };

  return { tipo: 'respuesta', respuesta: textoDelResumen(resumen, horaLegible(expiraEn)) };
}

/** Dos listas de movimientos sin repetir: la huella es la identidad. */
function unirPorId(conocidos: readonly BankMovement[], nuevos: readonly BankMovement[]): BankMovement[] {
  const porId = new Map(conocidos.map((movimiento) => [movimiento.id ?? '', movimiento]));
  nuevos.forEach((movimiento) => porId.set(movimiento.id ?? '', movimiento));
  return [...porId.values()];
}

/**
 * Aplica el extracto que el tesorero confirmo: verifica los pagos y emite sus
 * recibos.
 *
 * El estado de la importacion se cierra **antes** de tocar un solo pago. Ese
 * UPDATE condicionado es lo que impide que dos "SI" seguidos —que llegan como
 * dos corridas del worker— apliquen dos veces y emitan dos recibos.
 */
export async function aplicarConfirmacion(deps: ConciliacionDeps, usuario: Usuario): Promise<string> {
  const ahora = deps.ahora?.() ?? new Date();
  const pendiente = await importacionPendienteDe(deps.db, usuario.id, ahora.toISOString());
  if (!pendiente) return NADA_ESPERANDO;

  if (!await cerrarImportacion(deps.db, pendiente.id, 'APLICADA', usuario.id, ahora.toISOString())) {
    return YA_NO_VALE;
  }

  const movimientos = await movimientosDeBanco(deps.db);
  const resultado = await reconcilePendingPayments(deps.store, movimientos, ORIGEN, ahora, usuario.id);

  return [
    `Listo. ${resultado.verified} pago(s) verificado(s) y ${resultado.receipts} recibo(s) emitido(s).`,
    `${resultado.notFound} sin respaldo del banco, ${resultado.review} para revisar.`,
  ].join(' ');
}

export async function cancelarConfirmacion(deps: ConciliacionDeps, usuario: Usuario): Promise<string> {
  const ahora = deps.ahora?.() ?? new Date();
  const pendiente = await importacionPendienteDe(deps.db, usuario.id, ahora.toISOString());
  if (!pendiente) return NADA_ESPERANDO;

  await cerrarImportacion(deps.db, pendiente.id, 'CANCELADA', usuario.id, ahora.toISOString());
  return 'Descartado. No se aplicó nada.';
}
