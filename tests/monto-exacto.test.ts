import { describe, expect, it, afterEach } from 'vitest';
import { receiptReviewReason } from '@/src/services/validation';
import { resetEnvForTests } from '@/src/config/env';
import type { ReceiptExtraction } from '@/src/domain/types';

/**
 * El monto de una transferencia se exige exacto, y el multiplo no se reparte.
 *
 * La invariante 6 del plan dice que un monto multiplo exacto de la cuota se
 * reparte entre los meses atrasados. **No esta construido.** Quien paga dos
 * meses de una vez cae en `EN_REVISION` igual que quien manda un monto raro.
 *
 * Esta prueba fija lo que el sistema hace hoy, no lo que el plan promete, y
 * existe por una razon concreta: escribi en la pagina publica que el multiplo
 * se repartia, leyendo el plan en vez del codigo. Mientras la invariante 6 no
 * se construya, esto es lo que hay que poder citar.
 *
 * Cuando se construya (seccion 7 del plan), el caso del multiplo cambia de
 * resultado y esta prueba tiene que cambiar con el. El del monto raro no.
 */
const CUOTA = 150;

const comprobante = (amount: number): ReceiptExtraction => ({
  amount,
  confidence: 0.9,
  beneficiary: undefined,
  destinationAccountMasked: undefined,
} as ReceiptExtraction);

afterEach(() => { resetEnvForTests(); });

describe('el monto de una transferencia', () => {
  it('pasa cuando es la cuota exacta', () => {
    expect(receiptReviewReason(comprobante(CUOTA))).toBeUndefined();
  });

  it('va a revision cuando falta', () => {
    expect(receiptReviewReason(comprobante(CUOTA - 50))).toBe('amount_below_expected');
  });

  it('va a revision cuando sobra', () => {
    expect(receiptReviewReason(comprobante(CUOTA + 25))).toBe('amount_above_expected');
  });

  /** Dos meses de una vez: el plan dice repartir, el codigo manda a revision. */
  it('va a revision aunque sea multiplo exacto de la cuota', () => {
    expect(receiptReviewReason(comprobante(CUOTA * 2))).toBe('amount_above_expected');
  });
});
