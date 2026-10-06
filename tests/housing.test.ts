import { describe, expect, it } from 'vitest';
import { codigoConGuiones, homeCodeLegible, parseHomeReference } from '@/src/domain/housing';

describe('parseHomeReference', () => {
  it.each([
    ['E1 B4 C18', { stage: '1', block: '4', house: '18' }],
    ['Etapa 1 Bloque 4 Casa 18', { stage: '1', block: '4', house: '18' }],
    ['E1-B4-C18', { stage: '1', block: '4', house: '18' }],
    ['B4 C18 E1', { stage: '1', block: '4', house: '18' }],
    ['Casa 103 Etapa 2 Bloque 12', { stage: '2', block: '12', house: '103' }],
  ])('parses %s', (input, expected) => {
    expect(parseHomeReference(input)).toEqual(expected);
  });

  it.each(['B4 C18', 'E1 C18', 'E1 B4', 'Cuota septiembre', 'E0 B4 C18', 'E1 B0 C18'])('rejects incomplete or invalid %s', (input) => {
    expect(parseHomeReference(input)).toBeUndefined();
  });
});

/**
 * El codigo con guiones es el que sale por WhatsApp.
 *
 * Pegado —`E1B4C18`— se lee como una matricula; con guiones se ven las tres
 * partes de un vistazo, que es lo que el residente compara con su casa.
 * `viviendas.codigo` sigue guardando la forma pegada, porque es clave de
 * unicidad: se traduce al mostrarla.
 */
describe('el codigo con guiones', () => {
  it('parte el codigo en sus tres partes', () => {
    expect(codigoConGuiones('E1B4C18')).toBe('E1-B4-C18');
  });

  /** Bloques y casas admiten letras (`E1BAC18`): el corte no puede ser por posicion. */
  it('aguanta bloques y casas con letras', () => {
    expect(codigoConGuiones('E1BAC18')).toBe('E1-BA-C18');
    expect(codigoConGuiones('E2B3C12B')).toBe('E2-B3-C12B');
  });

  it('se arma igual desde las partes', () => {
    expect(homeCodeLegible({ stage: '3', block: '1', house: '1' })).toBe('E3-B1-C1');
  });

  /** Lo que sale tiene que poder volver a entrar: es lo que el residente copia. */
  it('lo que sale lo vuelve a entender el parser', () => {
    const vivienda = { stage: '1', block: 'A', house: '18' };
    expect(parseHomeReference(homeCodeLegible(vivienda))).toEqual(vivienda);
  });

  /** Un codigo que no se puede partir se devuelve tal cual, no se pierde. */
  it('un codigo raro se devuelve sin tocar', () => {
    expect(codigoConGuiones('loquesea')).toBe('loquesea');
  });
});
