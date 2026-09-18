import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from '@/src/domain/status-machine';

describe('la maquina de estados del pago', () => {
  it('deja recorrer el camino normal de una transferencia', () => {
    expect(canTransition('ESPERANDO_RESPUESTA', 'PENDIENTE_VERIFICACION')).toBe(true);
    expect(canTransition('PENDIENTE_VERIFICACION', 'VERIFICADO')).toBe(true);
  });

  /**
   * Recibido no es verificado (invariante 2). Solo un movimiento del extracto
   * del banco verifica una transferencia, y para eso el pago tiene que pasar
   * antes por `PENDIENTE_VERIFICACION`.
   */
  it('no deja verificar un pago que todavia no dice de que casa es', () => {
    expect(() => assertTransition('ESPERANDO_RESPUESTA', 'VERIFICADO')).toThrow(/Invalid payment state transition/);
  });

  /** El cierre de caja convierte el efectivo cobrado en verificado. */
  it('deja cuadrar la caja del cobrador', () => {
    expect(canTransition('EFECTIVO_COBRADO', 'VERIFICADO')).toBe(true);
  });

  /**
   * La correccion de un pago anulado entra como un pago nuevo, y el recibo se
   * reemplaza por otro numero; nunca se edita el anterior (invariante 10).
   */
  it('no deja resucitar un pago anulado', () => {
    expect(canTransition('ANULADO', 'VERIFICADO')).toBe(false);
    expect(canTransition('ANULADO', 'PENDIENTE_VERIFICACION')).toBe(false);
  });

  it('un rechazado solo puede volver a mirarse a mano', () => {
    expect(canTransition('RECHAZADO', 'EN_REVISION')).toBe(true);
    expect(canTransition('RECHAZADO', 'VERIFICADO')).toBe(false);
  });
});
