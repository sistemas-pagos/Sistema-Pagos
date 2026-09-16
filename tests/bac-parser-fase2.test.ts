import { describe, expect, it } from 'vitest';
import { SYNTHETIC_BAC_RECEIPTS } from '@/src/demo/data';
import { bacParser } from '@/src/parsers/bac';

const valido = SYNTHETIC_BAC_RECEIPTS.valid;

describe('parser BAC — etiquetas exactas', () => {
  it('no toma "De" como etiqueta del depositante', () => {
    // Una linea suelta que empieza con "De " ya no se confunde con el remitente.
    const texto = valido.replace('Remitente: JUAN PÉREZ DEMO', 'De acuerdo al convenio vigente');
    expect(bacParser.parse(texto).depositor).toBeUndefined();
  });

  it('no toma "Destino" como etiqueta del beneficiario', () => {
    const texto = valido.replace('Beneficiario: RESIDENCIAL DEMO', 'Destino: SUCURSAL CENTRO');
    expect(bacParser.parse(texto).beneficiary).toBeUndefined();
  });

  it('sigue leyendo las etiquetas reales', () => {
    const extraccion = bacParser.parse(valido);
    expect(extraccion.depositor).toBe('JUAN PÉREZ DEMO');
    expect(extraccion.beneficiary).toBe('RESIDENCIAL DEMO');
    expect(extraccion.reference).toBe('DEMOREF000001');
  });
});

describe('parser BAC — sin adivinar', () => {
  it('sin etiqueta de monto no inventa uno a partir del texto', () => {
    // Antes se quedaba con el mayor monto que encontrara, que podia ser el saldo
    // de la cuenta y no lo transferido.
    const texto = valido.replace('Monto: L150.00', 'Saldo disponible L9,900.00');
    const extraccion = bacParser.parse(texto);

    expect(extraccion.amount).toBeUndefined();
    expect(extraccion.warnings).toContain('amount_missing');
  });

  it('busca la vivienda solo en el detalle, no en todo el texto', () => {
    // 'E1 B4 C18' aparece en una linea que no es el detalle: se ignora.
    const texto = valido
      .replace('Detalle: E1 B4 C18', 'Detalle: Cuota mensual')
      .replace('Referencia: DEMOREF000001', 'Referencia: E1 B4 C18');
    const extraccion = bacParser.parse(texto);

    expect(extraccion.home).toBeUndefined();
    expect(extraccion.warnings).toContain('home_missing');
  });

  it('lee la vivienda cuando sí está en el detalle', () => {
    expect(bacParser.parse(valido).home).toEqual({ stage: 1, block: 4, house: 18 });
  });
});

describe('parser BAC — fechas', () => {
  it('lee una fecha con el mes escrito en texto', () => {
    const texto = valido.replace('Fecha: 07/09/2026', 'Fecha: 07 de septiembre de 2026');
    expect(bacParser.parse(texto).transactionDate).toBe('2026-09-07');
  });

  it('lee el mes abreviado y con guiones', () => {
    const texto = valido.replace('Fecha: 07/09/2026', 'Fecha: 7-SEP-2026');
    expect(bacParser.parse(texto).transactionDate).toBe('2026-09-07');
  });

  it('sigue leyendo el formato numérico', () => {
    expect(bacParser.parse(valido).transactionDate).toBe('2026-09-07');
  });

  it('un mes que no existe no produce fecha', () => {
    const texto = valido.replace('Fecha: 07/09/2026', 'Fecha: 07 de xxxxx de 2026');
    expect(bacParser.parse(texto).transactionDate).toBeUndefined();
  });
});
