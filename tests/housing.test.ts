import { describe, expect, it } from 'vitest';
import { parseHomeReference } from '@/src/domain/housing';

describe('parseHomeReference', () => {
  it.each([
    ['E1 B4 C18', { stage: 1, block: 4, house: 18 }],
    ['Etapa 1 Bloque 4 Casa 18', { stage: 1, block: 4, house: 18 }],
    ['E1-B4-C18', { stage: 1, block: 4, house: 18 }],
    ['B4 C18 E1', { stage: 1, block: 4, house: 18 }],
    ['Casa 103 Etapa 2 Bloque 12', { stage: 2, block: 12, house: 103 }],
  ])('parses %s', (input, expected) => {
    expect(parseHomeReference(input)).toEqual(expected);
  });

  it.each(['B4 C18', 'E1 C18', 'E1 B4', 'Cuota septiembre', 'E0 B4 C18', 'E1 B0 C18'])('rejects incomplete or invalid %s', (input) => {
    expect(parseHomeReference(input)).toBeUndefined();
  });
});
