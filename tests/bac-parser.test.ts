import { describe, expect, it } from 'vitest';
import { SYNTHETIC_BAC_RECEIPTS } from '@/src/demo/data';
import { bacParser } from '@/src/parsers/bac';

describe('BAC parser', () => {
  it('extracts a valid synthetic BAC receipt', () => {
    const result = bacParser.parse(SYNTHETIC_BAC_RECEIPTS.valid);
    expect(bacParser.detect(SYNTHETIC_BAC_RECEIPTS.valid)).toBeGreaterThanOrEqual(0.5);
    expect(result.bank).toBe('BAC Honduras');
    expect(result.depositor).toBe('JUAN PÉREZ DEMO');
    expect(result.transactionDate).toBe('2026-09-07');
    expect(result.transactionTime).toBe('08:12');
    expect(result.amount).toBe(150);
    expect(result.detail).toBe('E1 B4 C18');
    expect(result.reference).toBe('DEMOREF000001');
    expect(result.beneficiary).toBe('RESIDENCIAL DEMO');
    expect(result.destinationAccountMasked).toBe('••••0001');
    expect(result.home).toEqual({ stage: 1, block: 4, house: 18 });
  });

  it.each([
    'Detalle: B4 C18',
    'Detalle: E1 C18',
    'Detalle: E1 B4',
  ])('keeps an incomplete EBC detail unidentified: %s', (detail) => {
    const receipt = SYNTHETIC_BAC_RECEIPTS.valid.replace('Detalle: E1 B4 C18', detail);
    const result = bacParser.parse(receipt);
    expect(result.home).toBeUndefined();
    expect(result.warnings).toContain('home_missing');
  });

  it('handles a BAC receipt with no detail field without inventing a home', () => {
    const receipt = [
      'BAC CREDOMATIC', 'Transferencia realizada', 'Remitente: PERSONA DEMO', 'Fecha: 07/09/2026', 'Hora: 10:20 AM',
      'Monto: L150.00', 'Referencia: DEMOREF000099', 'Beneficiario: RESIDENCIAL DEMO', 'Cuenta destino: 000000000099',
    ].join('\n');
    const result = bacParser.parse(receipt);
    expect(result.detail).toBeUndefined();
    expect(result.home).toBeUndefined();
    expect(result.reference).toBe('DEMOREF000099');
    expect(result.warnings).toContain('home_missing');
  });
});
