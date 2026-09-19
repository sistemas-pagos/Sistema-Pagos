import { assertTransition } from '@/src/domain/status-machine';
import type { PaymentRecord, PaymentStatus } from '@/src/domain/types';

/**
 * Las acciones que una persona puede tomar sobre un pago desde el panel.
 *
 * Viven aca y no en la ruta HTTP para que se puedan probar sin servidor: lo que
 * importa de estas reglas no es el formulario, sino que **ningun pago quede sin
 * salida** y que ninguna accion se salte una validacion.
 */

/**
 * Desde que estados tiene sentido cambiarle la vivienda a un pago (H8).
 *
 * `DUPLICADO` no esta, y es el que importa: la ruta no miraba el estado, asi
 * que reasignar la casa de un duplicado lo dejaba en PENDIENTE_VERIFICACION y
 * desde ahi se podia verificar. Con la fase 4 conectada eso ya no es un estado
 * raro en una tabla: es un recibo emitido por plata que entro una sola vez.
 *
 * `VERIFICADO` tampoco: mover la casa de un pago ya verificado es mover dinero
 * de una vivienda a otra, y eso no puede ser el mismo boton que corregir una
 * casa mal leida.
 */
const PUEDEN_CAMBIAR_DE_VIVIENDA = new Set<PaymentStatus>([
  'ESPERANDO_RESPUESTA',
  'PENDIENTE_VERIFICACION',
  'EN_REVISION',
  'NO_ENCONTRADO',
]);

export function puedeCambiarDeVivienda(pago: PaymentRecord): boolean {
  return PUEDEN_CAMBIAR_DE_VIVIENDA.has(pago.status);
}

/**
 * En que estado queda un pago al que se le corrige la vivienda.
 *
 * Un `NO_ENCONTRADO` se queda como esta: cambiarle la casa no hace que el banco
 * lo respalde, y la conciliacion del proximo extracto lo vuelve a mirar igual.
 * Pasarlo a PENDIENTE_VERIFICACION le reservaba otra vez el mes a una vivienda
 * por un deposito que nunca aparecio — y era ademas una transicion que la
 * maquina de estados no permite.
 */
export function estadoTrasCambiarVivienda(pago: PaymentRecord, motivoPendiente: string | undefined): PaymentStatus {
  if (pago.status === 'NO_ENCONTRADO') return 'NO_ENCONTRADO';
  const destino: PaymentStatus = motivoPendiente ? 'EN_REVISION' : 'PENDIENTE_VERIFICACION';
  assertTransition(pago.status, destino);
  return destino;
}

/**
 * Desde donde se puede rechazar y desde donde marcar "no encontrado".
 *
 * No son la misma lista, y la diferencia la manda `status-machine.ts`: un pago
 * que todavia espera la vivienda se puede rechazar, pero no se puede decir que
 * el banco no lo respalda —nunca se busco, porque no se sabe de que casa es—.
 *
 * Tenerlas juntas no era un detalle: `construirNoEncontrado` tiraba desde
 * ESPERANDO_RESPUESTA por una transicion invalida, la ruta no lo atajaba y el
 * pedido terminaba en 500. La invariante 14 prohibe justamente eso.
 *
 * Un pago ya verificado no se cierra por aca: se anula, que deja otro rastro
 * (invariante 10).
 */
const PUEDEN_RECHAZARSE = new Set<PaymentStatus>([
  'ESPERANDO_RESPUESTA',
  'PENDIENTE_VERIFICACION',
  'EN_REVISION',
  'NO_ENCONTRADO',
]);

const PUEDEN_MARCARSE_SIN_RESPALDO = new Set<PaymentStatus>([
  'PENDIENTE_VERIFICACION',
  'EN_REVISION',
]);

export function puedeRechazarse(pago: PaymentRecord): boolean {
  return PUEDEN_RECHAZARSE.has(pago.status);
}

export function puedeMarcarseSinRespaldo(pago: PaymentRecord): boolean {
  return PUEDEN_MARCARSE_SIN_RESPALDO.has(pago.status);
}

/**
 * Rechaza el pago con un motivo escrito por la persona (H9).
 *
 * Sin esto, un pago con un monto distinto de la cuota no tenia salida: no se
 * podia verificar —la validacion del monto lo impide, y esta bien que lo
 * impida— y no habia forma de cerrarlo. Se quedaba en revision para siempre,
 * ocupando el mes de esa vivienda.
 *
 * `RECHAZADO` libera el mes (invariante 5), que es justamente lo que hace falta
 * para que la casa pueda volver a pagar ese mes.
 */
export function construirRechazo(pago: PaymentRecord, motivo: string, ahora: Date): PaymentRecord {
  const limpio = motivo.trim();
  if (!limpio) throw new Error('rejection_reason_required');
  if (!puedeRechazarse(pago)) throw new Error('payment_not_closable');
  assertTransition(pago.status, 'RECHAZADO');

  return {
    ...pago,
    status: 'RECHAZADO',
    reviewReason: limpio,
    updatedAt: ahora.toISOString(),
  };
}

/**
 * Marca que el banco no respalda este comprobante.
 *
 * Es distinto de rechazarlo: `NO_ENCONTRADO` vuelve a entrar en la conciliacion
 * del proximo extracto, asi que el deposito que llegue tarde todavia lo puede
 * verificar. Rechazar es decir "este pago no va".
 */
export function construirNoEncontrado(pago: PaymentRecord, ahora: Date): PaymentRecord {
  if (!puedeMarcarseSinRespaldo(pago)) throw new Error('payment_not_closable');
  assertTransition(pago.status, 'NO_ENCONTRADO');

  return {
    ...pago,
    status: 'NO_ENCONTRADO',
    reviewReason: 'manual_admin_not_found',
    updatedAt: ahora.toISOString(),
  };
}
