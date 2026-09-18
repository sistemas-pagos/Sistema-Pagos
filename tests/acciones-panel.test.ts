import { describe, expect, it } from 'vitest';
import type { PaymentRecord } from '@/src/domain/types';
import {
  construirNoEncontrado,
  construirRechazo,
  estadoTrasCambiarVivienda,
  puedeCambiarDeVivienda,
  puedeMarcarseSinRespaldo,
  puedeRechazarse,
} from '@/src/services/acciones-panel';
import { LIBERAN_EL_MES_PARA_PRUEBAS } from '@/src/services/period-assignment';

const AHORA = new Date('2026-09-16T12:00:00.000Z');

function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
    sourceMessageId: 'msg-1', phone: '50400000001', bank: 'BAC Honduras', amount: 150,
    transactionDate: '2026-09-02', reference: '412000001', stage: '1', block: '4', house: '18',
    period: '2026-09', status: 'EN_REVISION', fileHash: 'sha-1', ...overrides,
  };
}

describe('H8: cambiar la vivienda de un pago', () => {
  /**
   * La ruta no miraba el estado. Reasignar la casa de un DUPLICADO lo dejaba en
   * PENDIENTE_VERIFICACION y desde ahi se podia verificar. Con la fase 4
   * conectada eso ya no es un estado raro en una tabla: es un recibo emitido
   * por plata que entro una sola vez.
   */
  it('no deja reasignar un duplicado', () => {
    expect(puedeCambiarDeVivienda(pago({ status: 'DUPLICADO', duplicateOf: 'pay-0' }))).toBe(false);
  });

  /** Mover la casa de un pago verificado es mover dinero entre viviendas. */
  it('no deja reasignar un pago ya verificado', () => {
    expect(puedeCambiarDeVivienda(pago({ status: 'VERIFICADO' }))).toBe(false);
  });

  it('no deja reasignar un rechazado ni un anulado', () => {
    expect(puedeCambiarDeVivienda(pago({ status: 'RECHAZADO' }))).toBe(false);
    expect(puedeCambiarDeVivienda(pago({ status: 'ANULADO' }))).toBe(false);
  });

  /** Corregir una casa mal leida es justamente para lo que sirve. */
  it('deja corregir la casa de lo que todavia esta en curso', () => {
    for (const estado of ['ESPERANDO_RESPUESTA', 'PENDIENTE_VERIFICACION', 'EN_REVISION', 'NO_ENCONTRADO'] as const) {
      expect(puedeCambiarDeVivienda(pago({ status: estado }))).toBe(true);
    }
  });
});

describe('H9: un pago en revision tiene salida', () => {
  /**
   * Eduardo decidio que todo monto mayor a la cuota lo revise una persona. Pero
   * esa revision no tenia salida: el pago no se podia verificar —la validacion
   * del monto lo impide, y esta bien que lo impida— y no habia forma de
   * cerrarlo. Se quedaba ocupando el mes de esa vivienda para siempre.
   */
  const montoRaro = () => pago({ amount: 300, reviewReason: 'amount_above_expected' });

  it('se puede rechazar con un motivo escrito', () => {
    const rechazado = construirRechazo(montoRaro(), 'Pagó dos meses; se registra aparte', AHORA);

    expect(rechazado.status).toBe('RECHAZADO');
    expect(rechazado.reviewReason).toBe('Pagó dos meses; se registra aparte');
    expect(rechazado.updatedAt).toBe(AHORA.toISOString());
  });

  /** Cerrar un caso sin decir por que es perder la unica explicacion que habia. */
  it('exige el motivo', () => {
    expect(() => construirRechazo(montoRaro(), '   ', AHORA)).toThrow('rejection_reason_required');
  });

  /**
   * Lo que importa no es que diga RECHAZADO: es que ese estado **libere el
   * mes** (invariante 5), para que la casa pueda volver a pagarlo. Se comprueba
   * contra la lista que usa la asignacion de meses, no contra el texto.
   */
  it('deja el pago en un estado que libera el mes', () => {
    const rechazado = construirRechazo(montoRaro(), 'motivo', AHORA);

    expect(LIBERAN_EL_MES_PARA_PRUEBAS.has(rechazado.status)).toBe(true);
  });

  /**
   * No encontrado es distinto de rechazado: vuelve a entrar en la conciliacion
   * del proximo extracto, asi que un deposito que llegue tarde todavia lo
   * puede verificar.
   */
  it('se puede marcar como no respaldado por el banco', () => {
    const marcado = construirNoEncontrado(pago({ status: 'PENDIENTE_VERIFICACION' }), AHORA);

    expect(marcado.status).toBe('NO_ENCONTRADO');
    expect(marcado.reviewReason).toBe('manual_admin_not_found');
  });

  /** Un pago verificado no se rechaza por aca: se anula, que deja otro rastro. */
  it('no deja cerrar un pago ya verificado', () => {
    expect(puedeRechazarse(pago({ status: 'VERIFICADO' }))).toBe(false);
    expect(() => construirRechazo(pago({ status: 'VERIFICADO' }), 'motivo', AHORA))
      .toThrow('payment_not_closable');
  });

  it('no deja cerrar dos veces lo que ya se cerro', () => {
    expect(() => construirNoEncontrado(pago({ status: 'RECHAZADO' }), AHORA)).toThrow('payment_not_closable');
    expect(() => construirRechazo(pago({ status: 'DUPLICADO' }), 'motivo', AHORA)).toThrow('payment_not_closable');
  });

  /**
   * Un pago que todavia espera la vivienda se puede rechazar, pero no se puede
   * decir que el banco no lo respalda: nunca se busco, porque no se sabe de que
   * casa es. Tenerlos en la misma lista hacia que la accion tirara por una
   * transicion invalida y el pedido terminara en 500 — justo lo que la
   * invariante 14 prohibe.
   */
  it('no deja marcar sin respaldo lo que todavia no dice de que casa es', () => {
    expect(puedeMarcarseSinRespaldo(pago({ status: 'ESPERANDO_RESPUESTA' }))).toBe(false);
    expect(() => construirNoEncontrado(pago({ status: 'ESPERANDO_RESPUESTA' }), AHORA))
      .toThrow('payment_not_closable');
    expect(puedeRechazarse(pago({ status: 'ESPERANDO_RESPUESTA' }))).toBe(true);
  });
});

describe('corregir la vivienda no revive un pago', () => {
  /**
   * Cambiarle la casa a un `NO_ENCONTRADO` no hace que el banco lo respalde.
   * Pasarlo a PENDIENTE_VERIFICACION le reservaba otra vez el mes a una
   * vivienda por un deposito que nunca aparecio, y era ademas una transicion
   * que la maquina de estados no permite.
   */
  it('un NO_ENCONTRADO se queda como esta', () => {
    expect(estadoTrasCambiarVivienda(pago({ status: 'NO_ENCONTRADO' }), undefined)).toBe('NO_ENCONTRADO');
  });

  it('lo que estaba en curso vuelve a la cola de verificacion', () => {
    expect(estadoTrasCambiarVivienda(pago({ status: 'ESPERANDO_RESPUESTA' }), undefined)).toBe('PENDIENTE_VERIFICACION');
  });

  it('si queda otro motivo abierto, sigue en revision', () => {
    expect(estadoTrasCambiarVivienda(pago({ status: 'EN_REVISION' }), 'amount_above_expected')).toBe('EN_REVISION');
  });
});
