import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES } from '@/src/domain/types';

/**
 * El codigo y el esquema tienen que nombrar los mismos estados.
 *
 * No es simetria por gusto: mientras estuvieron separados, el dominio tenia
 * cuatro estados que el `CHECK` de `pagos` rechaza y la base tenia dos que el
 * codigo no conocia. Guardar un pago en Turso habria fallado en produccion, con
 * el comprobante del vecino ya recibido, y nada en CI lo habria dicho antes.
 *
 * Se lee del archivo de migracion y no de una copia, porque una copia se
 * desactualiza igual que lo que viene a vigilar.
 */
async function estadosDeLaMigracion(): Promise<string[]> {
  const sql = await fs.readFile('migrations/001_inicial.sql', 'utf8');
  const tabla = /CREATE TABLE pagos \(([\s\S]*?)\n\);/.exec(sql);
  if (!tabla) throw new Error('No se encontro la tabla pagos en la migracion 001.');

  const check = /estado TEXT NOT NULL CHECK \(estado IN \(([\s\S]*?)\)\)/.exec(tabla[1]);
  if (!check) throw new Error('No se encontro el CHECK del estado en la tabla pagos.');

  return [...check[1].matchAll(/'([A-Z_]+)'/g)].map((encontrado) => encontrado[1]);
}

describe('los estados del pago', () => {
  it('son exactamente los mismos en el codigo y en la migracion', async () => {
    const enLaBase = await estadosDeLaMigracion();

    expect([...PAYMENT_STATUSES].sort()).toEqual([...enLaBase].sort());
  });

  /** Si la migracion dejara de traerlos, la comparacion de arriba pasaria vacia. */
  it('la migracion trae los nueve', async () => {
    expect(await estadosDeLaMigracion()).toHaveLength(9);
  });
});
