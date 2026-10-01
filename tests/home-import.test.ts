import { describe, expect, it } from 'vitest';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import { HomeImportError, parseHomesImport } from '@/src/services/home-import';
import { BASE_PERIOD, PRIMER_DIA_DE_SERVICIO } from '@/src/domain/periods';
import type { HomeRecord } from '@/src/domain/types';
import { TursoPaymentStore } from '@/src/storage/turso-store';

const existing: HomeRecord[] = [
  { id: 'home-e1-b1-c1', stage: '1', block: '1', house: '1', monthlyFee: 150, active: true },
];

describe('bulk housing import', () => {
  it('parses Spanish CSV headers and defaults a missing fee to L150', () => {
    const homes = parseHomesImport([
      'etapa,bloque,casa,cuota,responsable,activa,fecha_alta',
      '1,2,3,150,Persona Demo A,si,2026-08-01',
      '1,2,4,,Persona Demo B,no,2026-08-01',
    ].join('\n'));
    expect(homes).toHaveLength(2);
    expect(homes[0]).toMatchObject({ id: 'home-e1-b2-c3', stage: '1', block: '2', house: '3', monthlyFee: 150, active: true });
    expect(homes[1]).toMatchObject({ id: 'home-e1-b2-c4', monthlyFee: 150, active: false });
  });

  it('accepts tab-separated rows pasted from a spreadsheet with English aliases', () => {
    const input = [
      'stage\tblock\thouse\tmonthly_fee\tresponsible\tactive',
      '2\t4\t18\t150\tPersona Demo\ttrue',
    ].join('\n');
    expect(parseHomesImport(input)[0]).toMatchObject({ stage: '2', block: '4', house: '18', responsible: 'Persona Demo', monthlyFee: 150, active: true });
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

/**
 * El padron no se sella con la fecha en que alguien lo subio.
 *
 * `saveHomes` ponia `new Date()` cuando la fila no traia fecha de alta. Cargar
 * el padron un 1 de octubre dejaba a las 600 casas debiendo desde octubre, y
 * septiembre —el primer mes de servicio— sin cobrar a nadie. La fecha de la
 * carga no puede decidir desde cuando debe cada casa.
 */
describe('una vivienda sin fecha de alta', () => {
  it('arranca en el primer mes de servicio, no el dia de la carga', async () => {
    const db = await nuevaBaseDePrueba();
    const store = new TursoPaymentStore(db);

    await store.saveHomes([{
      id: 'home-e3-b32-c1', stage: '3', block: '32', house: '1',
      monthlyFee: 150, active: true,
    }]);

    const { rows } = await db.execute("SELECT fecha_alta FROM viviendas WHERE id = 'home-e3-b32-c1'");
    expect(String(rows[0].fecha_alta)).toBe(PRIMER_DIA_DE_SERVICIO);
    expect(PRIMER_DIA_DE_SERVICIO.slice(0, 7)).toBe(BASE_PERIOD);

    db.close();
  });

  it('respeta la fecha cuando la fila la trae', async () => {
    const db = await nuevaBaseDePrueba();
    const store = new TursoPaymentStore(db);

    await store.saveHomes([{
      id: 'home-e1-b1-c9', stage: '1', block: '1', house: '9',
      monthlyFee: 150, active: true, startDate: '2027-04-01',
    }]);

    const { rows } = await db.execute("SELECT fecha_alta FROM viviendas WHERE id = 'home-e1-b1-c9'");
    expect(String(rows[0].fecha_alta)).toBe('2027-04-01');

    db.close();
  });
});
