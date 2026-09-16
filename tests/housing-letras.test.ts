import { describe, expect, it } from 'vitest';
import { SYNTHETIC_BAC_RECEIPTS } from '@/src/demo/data';
import {
  compareHomeParts, compareHomes, homeCode, isValidHome, normalizeHomePart, parseHomeReference,
} from '@/src/domain/housing';
import type { HomeRecord } from '@/src/domain/types';
import { bacParser } from '@/src/parsers/bac';
import { processReceiptMessage } from '@/src/services/payment-processor';
import { MemoryPaymentStore } from '@/src/storage/memory';

describe('viviendas con letras', () => {
  it('reconoce un bloque con letra', () => {
    expect(parseHomeReference('E1BAC18')).toEqual({ stage: '1', block: 'A', house: '18' });
    expect(parseHomeReference('E1 BA C18')).toEqual({ stage: '1', block: 'A', house: '18' });
    expect(parseHomeReference('Etapa1BloqueACasa18')).toEqual({ stage: '1', block: 'A', house: '18' });
  });

  it('reconoce una casa con letra', () => {
    expect(parseHomeReference('E1B4C18B')).toEqual({ stage: '1', block: '4', house: '18B' });
    expect(parseHomeReference('Casa 18B, Bloque A, Etapa 1')).toEqual({ stage: '1', block: 'A', house: '18B' });
  });

  it('sigue reconociendo las viviendas solo numéricas', () => {
    expect(parseHomeReference('E1B4C18')).toEqual({ stage: '1', block: '4', house: '18' });
  });

  it('arma el código compacto', () => {
    expect(homeCode({ stage: '1', block: 'A', house: '18B' })).toBe('E1BAC18B');
  });
});

describe('normalización', () => {
  it('los ceros a la izquierda no crean viviendas distintas', () => {
    expect(normalizeHomePart('018')).toBe('18');
    expect(normalizeHomePart('18')).toBe('18');
  });

  it('las minúsculas y los acentos no crean bloques distintos', () => {
    expect(normalizeHomePart('a')).toBe('A');
    expect(normalizeHomePart(' A ')).toBe('A');
  });

  it('un valor con letras conserva sus ceros', () => {
    // Ahí el cero puede ser parte del nombre, no un relleno.
    expect(normalizeHomePart('0A')).toBe('0A');
  });

  it('rechaza lo que no identifica una vivienda', () => {
    expect(isValidHome('1', '4', '18')).toBe(true);
    expect(isValidHome('1', 'A', '18B')).toBe(true);
    expect(isValidHome('0', '4', '18')).toBe(false);
    expect(isValidHome('', '4', '18')).toBe(false);
    expect(isValidHome('1', '4', 'CASA-18')).toBe(false);
  });
});

describe('orden', () => {
  it('ordena por número cuando ambos lo son', () => {
    expect(['10', '9', '1'].sort(compareHomeParts)).toEqual(['1', '9', '10']);
  });

  it('los números van antes que las letras', () => {
    expect(['B', '4', 'A', '10'].sort(compareHomeParts)).toEqual(['4', '10', 'A', 'B']);
  });

  it('ordena viviendas por etapa, bloque y casa', () => {
    const viviendas = [
      { stage: '1', block: 'A', house: '2' },
      { stage: '1', block: '4', house: '10' },
      { stage: '1', block: '4', house: '9' },
    ];
    expect([...viviendas].sort(compareHomes).map(homeCode)).toEqual(['E1B4C9', 'E1B4C10', 'E1BAC2']);
  });
});

describe('flujo completo con un bloque con letra', () => {
  it('asigna un comprobante a la vivienda del bloque A', async () => {
    const homes: HomeRecord[] = [
      { id: 'h-a', stage: '1', block: 'A', house: '18', monthlyFee: 150, active: true, startDate: '2026-09-01' },
    ];
    const now = () => new Date('2026-09-10T12:00:00Z');
    const store = new MemoryPaymentStore({ homes }, now);
    const texto = SYNTHETIC_BAC_RECEIPTS.valid.replace('Detalle: E1 B4 C18', 'Detalle: E1 BA C18');

    expect(bacParser.parse(texto).home).toEqual({ stage: '1', block: 'A', house: '18' });

    const r = await processReceiptMessage({
      messageId: 'm-a', phone: '+50400000000', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      declaredMime: 'image/png', syntheticOcrText: texto,
    }, { store, now });

    expect(r.status).toBe('PENDIENTE_VERIFICACION');
    const pago = (await store.listPayments())[0];
    expect(pago.block).toBe('A');
    expect(pago.period).toBe('2026-09');
  });
});
