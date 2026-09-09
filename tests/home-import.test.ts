import { describe, expect, it } from 'vitest';
import { HomeImportError, parseHomesImport } from '@/src/services/home-import';
import type { HomeRecord } from '@/src/domain/types';

const existing: HomeRecord[] = [
  { id: 'home-e1-b1-c1', stage: 1, block: 1, house: 1, monthlyFee: 150, active: true },
];

describe('bulk housing import', () => {
  it('parses Spanish CSV headers and defaults a missing fee to L150', () => {
    const homes = parseHomesImport([
      'etapa,bloque,casa,cuota,responsable,activa,fecha_alta',
      '1,2,3,150,Persona Demo A,si,2026-08-01',
      '1,2,4,,Persona Demo B,no,2026-08-01',
    ].join('\n'));
    expect(homes).toHaveLength(2);
    expect(homes[0]).toMatchObject({ id: 'home-e1-b2-c3', stage: 1, block: 2, house: 3, monthlyFee: 150, active: true });
    expect(homes[1]).toMatchObject({ id: 'home-e1-b2-c4', monthlyFee: 150, active: false });
  });

  it('accepts tab-separated rows pasted from a spreadsheet with English aliases', () => {
    const input = [
      'stage\tblock\thouse\tmonthly_fee\tresponsible\tactive',
      '2\t4\t18\t150\tPersona Demo\ttrue',
    ].join('\n');
    expect(parseHomesImport(input)[0]).toMatchObject({ stage: 2, block: 4, house: 18, responsible: 'Persona Demo', monthlyFee: 150, active: true });
  });

  it('rejects an address that already exists before any write can happen', () => {
    expect(() => parseHomesImport('etapa,bloque,casa\n1,1,1', existing)).toThrow('ya existe');
  });

  it('rejects duplicate EBC rows inside the same import', () => {
    expect(() => parseHomesImport('etapa,bloque,casa\n1,4,18\n1,4,18')).toThrow('duplicada');
  });

  it('rejects invalid dates and reversed validity ranges', () => {
    expect(() => parseHomesImport('etapa,bloque,casa,fecha_alta\n1,4,18,2026-02-31')).toThrow(HomeImportError);
    expect(() => parseHomesImport('etapa,bloque,casa,fecha_alta,fecha_baja\n1,4,18,2026-09-01,2026-08-01')).toThrow('anterior');
  });

  it('rejects unknown headers instead of guessing their meaning', () => {
    expect(() => parseHomesImport('etapa,bloque,casa,telefono\n1,4,18,0000')).toThrow('Encabezado no reconocido');
  });
});
