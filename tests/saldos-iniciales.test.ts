import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import { resetEnvForTests } from '@/src/config/env';
import type { HomeRecord } from '@/src/domain/types';
import { aCentavos } from '@/src/services/csv-pegado';
import { SaldosImportError, parseSaldosImport } from '@/src/services/saldos-import';
import { ajustesDeVivienda, registrarAjustes, viviendasConSaldoInicial } from '@/src/storage/ajustes';
import { TursoPaymentStore } from '@/src/storage/turso-store';

/**
 * El saldo inicial de cada vivienda (docs/PLAN.md, seccion 1 y fase 3).
 *
 * Lo que estas pruebas cuidan sobre todo es que **no entre dos veces**. Pegar
 * el archivo por las dudas es lo normal cuando uno no esta seguro de si la
 * primera vez funciono, y duplicar la deuda de todo el residencial en silencio
 * es un error que se descubre meses despues, cobrando de mas.
 */
let db: Client;
let store: TursoPaymentStore;

const CASAS: HomeRecord[] = [
  { id: 'v1', stage: '1', block: '4', house: '18', monthlyFee: 150, active: true, startDate: '2026-09-01' },
  { id: 'v2', stage: '1', block: '4', house: '19', monthlyFee: 150, active: true, startDate: '2026-09-01' },
];

const CREADO_EN = '2026-09-19T12:00:00.000Z';
const OPCIONES = { creadoPor: 'u-tesorero', creadoEn: CREADO_EN };

async function tesorero(): Promise<void> {
  await db.execute("INSERT INTO usuarios (id, nombre, rol) VALUES ('u-tesorero', 'Tesorero', 'TESORERO')");
}

function csv(...filas: string[]): string {
  return ['etapa,bloque,casa,monto', ...filas].join('\n');
}

beforeEach(async () => {
  process.env.APP_MODE = 'demo';
  resetEnvForTests();
  db = await nuevaBaseDePrueba();
  store = new TursoPaymentStore(db);
  await store.saveHomes(CASAS);
  await tesorero();
});

afterEach(() => {
  db.close();
  delete process.env.APP_MODE;
  resetEnvForTests();
});

describe('el monto a centavos', () => {
  /**
   * `parseFloat(...) * 100` es la cuenta que convierte 150.15 en
   * 15014.999999999998 y despues, al truncar, en 15014: un centavo que nadie
   * cobra nunca y que hace que el cuadre del mes no cierre.
   */
  it('no pierde centavos', () => {
    expect(aCentavos('150.15')).toBe(15_015);
    expect(aCentavos('1500')).toBe(150_000);
    expect(aCentavos('0.01')).toBe(1);
  });

  it('acepta lo que la gente escribe', () => {
    expect(aCentavos('L1,500.00')).toBe(150_000);
    expect(aCentavos(' 1 500,50 ')).toBe(150_050);
    expect(aCentavos('L450')).toBe(45_000);
  });

  it('rechaza lo que no es un monto', () => {
    expect(aCentavos('')).toBeUndefined();
    expect(aCentavos('mil')).toBeUndefined();
    expect(aCentavos('1.2.3')).toBeUndefined();
  });
});

describe('leer el archivo de saldos', () => {
  it('arma un ajuste por vivienda, en centavos enteros', () => {
    const { ajustes } = parseSaldosImport(csv('1,4,18,450', '1,4,19,1200'), CASAS, OPCIONES);

    expect(ajustes).toHaveLength(2);
    expect(ajustes[0]).toMatchObject({ viviendaId: 'v1', tipo: 'SALDO_INICIAL', montoCentavos: 45_000 });
    expect(ajustes[1]).toMatchObject({ viviendaId: 'v2', montoCentavos: 120_000 });
  });

  /**
   * Un monto con separador de miles trae una coma, que es el delimitador. Sin
   * comillas partiria la fila y el saldo entraria mal; el parser compartido es
   * el que cuida ese caso, y aca se comprueba de punta a punta.
   */
  it('lee un monto entrecomillado con coma adentro', () => {
    const entrada = ['etapa,bloque,casa,monto', '1,4,18,"L1,200.00"'].join('\n');
    expect(parseSaldosImport(entrada, CASAS, OPCIONES).ajustes[0].montoCentavos).toBe(120_000);
  });

  /**
   * Una casa que no esta en el padron casi siempre es un error de tipeo. Darla
   * de alta desde aca la dejaria sin fecha de alta ni cuota, y desde afuera se
   * veria igual que una vivienda de verdad.
   */
  it('falla si la vivienda no esta en el padron', () => {
    expect(() => parseSaldosImport(csv('9,9,99,450'), CASAS, OPCIONES))
      .toThrow(SaldosImportError);
  });

  it('falla si la misma vivienda aparece dos veces en el archivo', () => {
    expect(() => parseSaldosImport(csv('1,4,18,450', '1,4,18,300'), CASAS, OPCIONES))
      .toThrow(/dos veces/);
  });

  it('rechaza montos que no sirven', () => {
    expect(() => parseSaldosImport(csv('1,4,18,0'), CASAS, OPCIONES)).toThrow(/mayor que cero/);
    expect(() => parseSaldosImport(csv('1,4,18,abc'), CASAS, OPCIONES)).toThrow(/inválido/);
    expect(() => parseSaldosImport(csv('1,4,18,999999999'), CASAS, OPCIONES)).toThrow(/demasiado alto/);
  });

  it('acepta el encabezado escrito de otras formas', () => {
    const entrada = ['Etapa;Bloque;Casa;Saldo inicial', '1;4;18;450'].join('\n');
    expect(parseSaldosImport(entrada, CASAS, OPCIONES).ajustes[0].montoCentavos).toBe(45_000);
  });

  /** Reimportar es lo normal; las que ya tienen saldo se informan y no se tocan. */
  it('saltea las viviendas que ya tienen saldo inicial', () => {
    const resultado = parseSaldosImport(
      csv('1,4,18,450', '1,4,19,300'), CASAS,
      { ...OPCIONES, yaTienenSaldo: new Set(['v1']) },
    );

    expect(resultado.yaTenian).toBe(1);
    expect(resultado.ajustes).toHaveLength(1);
    expect(resultado.ajustes[0].viviendaId).toBe('v2');
  });

  it('pone un motivo por defecto y respeta el que venga', () => {
    const conMotivo = ['etapa,bloque,casa,monto,motivo', '1,4,18,450,"Acuerdo de asamblea"'].join('\n');
    expect(parseSaldosImport(conMotivo, CASAS, OPCIONES).ajustes[0].motivo).toBe('Acuerdo de asamblea');
    expect(parseSaldosImport(csv('1,4,18,450'), CASAS, OPCIONES).ajustes[0].motivo).toMatch(/primer mes de servicio/);
  });
});

describe('guardar los saldos', () => {
  it('los deja en la base y escribe un evento por cada uno', async () => {
    const { ajustes } = parseSaldosImport(csv('1,4,18,450', '1,4,19,300'), CASAS, OPCIONES);

    expect(await registrarAjustes(db, ajustes, 'panel', CREADO_EN)).toEqual({ registrados: 2, omitidos: 0 });

    expect(await ajustesDeVivienda(db, 'v1')).toMatchObject([{ tipo: 'SALDO_INICIAL', montoCentavos: 45_000 }]);
    const { rows } = await db.execute("SELECT count(*) AS c FROM eventos WHERE entidad = 'ajustes'");
    expect(Number(rows[0].c)).toBe(2);
  });

  /**
   * La garantia es del esquema (indice `ux_saldo_inicial_por_vivienda`), no de
   * este codigo: aunque alguien escriba directo en la base, la deuda no se
   * duplica.
   */
  it('no deja dos saldos iniciales para la misma vivienda', async () => {
    const { ajustes } = parseSaldosImport(csv('1,4,18,450'), CASAS, OPCIONES);
    await registrarAjustes(db, ajustes, 'panel', CREADO_EN);

    const segunda = parseSaldosImport(csv('1,4,18,450'), CASAS, { ...OPCIONES, creadoEn: '2026-09-20T12:00:00.000Z' });
    const resultado = await registrarAjustes(db, segunda.ajustes, 'panel', '2026-09-20T12:00:00.000Z');

    expect(resultado).toEqual({ registrados: 0, omitidos: 1 });
    expect(await ajustesDeVivienda(db, 'v1')).toHaveLength(1);
  });

  /** Otros tipos de ajuste si se repiten: solo el saldo inicial es unico. */
  it('deja varios ajustes de otro tipo en la misma vivienda', async () => {
    const dos = ['a1', 'a2'].map((id) => ({
      id, viviendaId: 'v1', tipo: 'AJUSTE' as const,
      montoCentavos: 5_000, motivo: 'Correccion', creadoPor: 'u-tesorero',
    }));

    expect(await registrarAjustes(db, dos, 'panel', CREADO_EN)).toEqual({ registrados: 2, omitidos: 0 });
  });

  /**
   * O entran todas o no entra ninguna: una carga a medias deja media lista de
   * casas con deuda y la otra media sin, y desde afuera las dos se ven igual.
   */
  it('no carga nada si una fila falla', async () => {
    const conAjena = [
      { id: 'a1', viviendaId: 'v1', tipo: 'SALDO_INICIAL' as const, montoCentavos: 45_000, motivo: 'x', creadoPor: 'u-tesorero' },
      { id: 'a2', viviendaId: 'no-existe', tipo: 'SALDO_INICIAL' as const, montoCentavos: 30_000, motivo: 'x', creadoPor: 'u-tesorero' },
    ];

    await expect(registrarAjustes(db, conAjena, 'panel', CREADO_EN)).rejects.toThrow();
    expect(await viviendasConSaldoInicial(db)).toEqual(new Set());
  });

  it('dice que viviendas ya tienen saldo inicial', async () => {
    const { ajustes } = parseSaldosImport(csv('1,4,18,450'), CASAS, OPCIONES);
    await registrarAjustes(db, ajustes, 'panel', CREADO_EN);

    expect(await viviendasConSaldoInicial(db)).toEqual(new Set(['v1']));
  });
});
