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
 * Los estados desde los que una persona puede cerrar un caso a mano.
 *
 * Un pago ya verificado no se rechaza por aca: se anula, que es otra cosa y
 * deja rastro distinto (invariante 10).
 */
const PUEDEN_CERRARSE = new Set<PaymentStatus>([
  'ESPERANDO_RESPUESTA',
  'PENDIENTE_VERIFICACION',
  'EN_REVISION',
  'NO_ENCONTRADO',
]);

export function puedeCerrarse(pago: PaymentRecord): boolean {
  return PUEDEN_CERRARSE.has(pago.status);
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
  if (!puedeCerrarse(pago)) throw new Error('payment_not_closable');
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
  if (!puedeCerrarse(pago)) throw new Error('payment_not_closable');
  assertTransition(pago.status, 'NO_ENCONTRADO');

  return {
    ...pago,
    status: 'NO_ENCONTRADO',
    reviewReason: 'manual_admin_not_found',
    updatedAt: ahora.toISOString(),
  };
}
