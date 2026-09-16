import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPendingMigrations, splitLeadingPragmas } from '@/src/storage/migrations';
import { createInMemoryClient } from '@/src/storage/turso-client';
import { ACTOR, CUOTA_CENTAVOS, contar, nuevaBaseDePrueba, sembrar } from './helpers/turso-test-db';
import {
  crearPago, crearVivienda, emitirRecibo, liberarMeses, registrarEvento,
  registrarMensaje, reservarMeses, verificarPagoConMovimiento,
} from '@/src/storage/turso';

const ALTA = '2026-09-01T00:00:00.000Z';

let db: Client;

async function vivienda(id = 'v1', bloque = '4'): Promise<void> {
  await crearVivienda(db, { id, etapa: '1', bloque, casa: '18', estado: 'ACTIVA', fechaAlta: ALTA }, ACTOR);
}

async function pago(id: string, viviendaId = 'v1'): Promise<void> {
  await crearPago(db, {
    id, metodo: 'TRANSFERENCIA', viviendaId, montoCentavos: CUOTA_CENTAVOS,
    estado: 'PENDIENTE_VERIFICACION', creadoEn: ALTA,
  }, ACTOR);
}

beforeEach(async () => { db = await nuevaBaseDePrueba(); await sembrar(db); });
afterEach(() => { db.close(); });

describe('migraciones', () => {
  it('aplica solo las pendientes y las registra', async () => {
    const limpia = await createInMemoryClient();
    const aplicadas = await applyPendingMigrations(limpia);

    // Se aplican todas las de migrations/, en orden, y la segunda corrida no repite.
    expect(aplicadas[0]).toBe('001_inicial.sql');
    expect(aplicadas).toEqual([...aplicadas].sort());
    expect(await applyPendingMigrations(limpia)).toEqual([]);
    expect(await contar(limpia, 'schema_migrations')).toBe(aplicadas.length);
    limpia.close();
  });

  it('rechaza una migracion que cambio despues de aplicarse', async () => {
    await db.execute("UPDATE schema_migrations SET sha256 = 'otro' WHERE version = '001'");
    await expect(applyPendingMigrations(db)).rejects.toThrow(/inmutables/);
  });

  it('saca los PRAGMA del cuerpo para que no se ignoren dentro de la transaccion', () => {
    const { pragmas, body } = splitLeadingPragmas('-- nota\nPRAGMA foreign_keys = ON;\nCREATE TABLE t (a TEXT);');
    expect(pragmas).toEqual(['PRAGMA foreign_keys = ON;']);
    expect(body).not.toMatch(/PRAGMA/);
    expect(body).toMatch(/CREATE TABLE/);
  });

  it('deja las claves foraneas activas', async () => {
    const { rows } = await db.execute('PRAGMA foreign_keys');
    expect(Number(rows[0].foreign_keys)).toBe(1);
  });
});

describe('restricciones del esquema', () => {
  it('un message_id duplicado no crea un segundo registro', async () => {
    const mensaje = {
      messageId: 'wamid.1', telefono: '+50400000000', tipo: 'image',
      estado: 'RECIBIDO' as const, recibidoEn: ALTA,
    };
    expect(await registrarMensaje(db, mensaje)).toBe(true);
    expect(await registrarMensaje(db, mensaje)).toBe(false);
    expect(await contar(db, 'mensajes')).toBe(1);
  });

  it('un movimiento bancario no verifica dos pagos', async () => {
    await vivienda();
    await pago('p1');
    await pago('p2');

    await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA,
    }, ACTOR);

    await expect(verificarPagoConMovimiento(db, {
      pagoId: 'p2', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA,
    }, ACTOR)).rejects.toThrow(/UNIQUE/i);

    const { rows } = await db.execute("SELECT id FROM pagos WHERE estado = 'VERIFICADO'");
    expect(rows.map((row) => row.id)).toEqual(['p1']);
  });

  it('un pago tiene un solo recibo', async () => {
    await vivienda();
    await pago('p1');

    await emitirRecibo(db, { pagoId: 'p1', emitidoEn: ALTA, actor: ACTOR });
    await expect(emitirRecibo(db, { pagoId: 'p1', emitidoEn: ALTA, actor: ACTOR }))
      .rejects.toThrow(/UNIQUE/i);
    expect(await contar(db, 'recibos')).toBe(1);
  });

  it('los numeros de recibo no se reutilizan aunque se borre uno', async () => {
    await vivienda();
    for (const id of ['p1', 'p2', 'p3']) await pago(id);

    const primero = await emitirRecibo(db, { pagoId: 'p1', emitidoEn: ALTA, actor: ACTOR });
    const segundo = await emitirRecibo(db, { pagoId: 'p2', emitidoEn: ALTA, actor: ACTOR });
    await db.execute({ sql: 'DELETE FROM recibos WHERE numero = ?', args: [segundo] });
    const tercero = await emitirRecibo(db, { pagoId: 'p3', emitidoEn: ALTA, actor: ACTOR });

    expect(primero).toBe(1);
    expect(segundo).toBe(2);
    expect(tercero).toBe(3);
  });

  it('no puede haber dos meses activos para la misma vivienda y periodo', async () => {
    await vivienda();
    await pago('p1');
    await pago('p2');

    const mes = [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }];
    await reservarMeses(db, { pagoId: 'p1', viviendaId: 'v1', meses: mes, actor: ACTOR, creadoEn: ALTA });

    await expect(reservarMeses(db, { pagoId: 'p2', viviendaId: 'v1', meses: mes, actor: ACTOR, creadoEn: ALTA }))
      .rejects.toThrow(/UNIQUE/i);
    expect(await contar(db, 'pago_meses')).toBe(1);
  });

  it('un mes PAGADO tampoco se puede reservar de nuevo', async () => {
    await vivienda();
    await pago('p1');
    await pago('p2');

    const mes = [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }];
    await reservarMeses(db, { pagoId: 'p1', viviendaId: 'v1', meses: mes, actor: ACTOR, creadoEn: ALTA });
    await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA,
    }, ACTOR);

    await expect(reservarMeses(db, { pagoId: 'p2', viviendaId: 'v1', meses: mes, actor: ACTOR, creadoEn: ALTA }))
      .rejects.toThrow(/UNIQUE/i);
  });

  it('un mes LIBERADO permite reservar de nuevo', async () => {
    await vivienda();
    await pago('p1');
    await pago('p2');

    const mes = [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }];
    await reservarMeses(db, { pagoId: 'p1', viviendaId: 'v1', meses: mes, actor: ACTOR, creadoEn: ALTA });
    await liberarMeses(db, { pagoId: 'p1', motivo: 'NO_ENCONTRADO', actor: ACTOR, creadoEn: ALTA });

    await reservarMeses(db, { pagoId: 'p2', viviendaId: 'v1', meses: mes, actor: ACTOR, creadoEn: ALTA });

    const { rows } = await db.execute(
      "SELECT pago_id FROM pago_meses WHERE estado = 'RESERVADO' AND periodo = '2026-09'",
    );
    expect(rows.map((row) => row.pago_id)).toEqual(['p2']);
  });

  it('eventos no se puede editar ni borrar', async () => {
    await registrarEvento(db, { entidad: 'pagos', entidadId: 'p1', accion: 'PRUEBA', actor: ACTOR }, ALTA);

    await expect(db.execute("UPDATE eventos SET accion = 'OTRA'")).rejects.toThrow(/inmutable/);
    await expect(db.execute('DELETE FROM eventos')).rejects.toThrow(/inmutable/);
    expect(await contar(db, 'eventos')).toBe(1);
  });

  it('el dinero solo admite centavos enteros positivos', async () => {
    await vivienda();
    await expect(crearPago(db, {
      id: 'p0', metodo: 'TRANSFERENCIA', viviendaId: 'v1', montoCentavos: 0,
      estado: 'PENDIENTE_VERIFICACION', creadoEn: ALTA,
    }, ACTOR)).rejects.toThrow(/CHECK/i);
  });
});
