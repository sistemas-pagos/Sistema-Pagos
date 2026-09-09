import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from '@/src/domain/status-machine';

describe('payment state machine', () => {
  it('allows the normal received-to-verified path', () => {
    expect(canTransition('COMPROBANTE_RECIBIDO', 'PROCESANDO')).toBe(true);
    expect(canTransition('PROCESANDO', 'EXTRAIDO')).toBe(true);
    expect(canTransition('EXTRAIDO', 'PENDIENTE_VERIFICACION')).toBe(true);
    expect(canTransition('PENDIENTE_VERIFICACION', 'VERIFICADO')).toBe(true);
  });

  it('blocks impossible verification directly from receipt arrival', () => {
    expect(() => assertTransition('COMPROBANTE_RECIBIDO', 'VERIFICADO')).toThrow(/Invalid payment state transition/);
  });
});
