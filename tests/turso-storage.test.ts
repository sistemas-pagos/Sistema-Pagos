import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, CUOTA_CENTAVOS, contar, nuevaBaseDePrueba, sembrar } from './helpers/turso-test-db';
import {
  codigoVivienda, crearPago, crearVivienda, emitirRecibo, enTransaccion, formatoRecibo,
  olvidarMedia, registrarMensaje, reservarMeses, verificarPagoConMovimiento,
} from '@/src/storage/turso';

const ALTA = '2026-09-01T00:00:00.000Z';

let db: Client;

beforeEach(async () => { db = await nuevaBaseDePrueba(); await sembrar(db); });
afterEach(() => { db.close(); });

describe('viviendas con letras', () => {
  it('guarda etapa, bloque y casa con letras y arma el codigo compacto', async () => {
    await crearVivienda(db, {
      id: 'vA', etapa: '1', bloque: 'A', casa: '18', estado: 'ACTIVA', fechaAlta: ALTA,
    }, ACTOR);

    const { rows } = await db.execute("SELECT etapa, bloque, casa, codigo FROM viviendas WHERE id = 'vA'");
    expect(rows[0]).toMatchObject({ etapa: '1', bloque: 'A', casa: '18', codigo: 'E1BAC18' });
  });

  it('admite casa con letra y no la confunde con otra vivienda', async () => {
    await crearVivienda(db, { id: 'v18', etapa: '1', bloque: '4', casa: '18', estado: 'ACTIVA', fechaAlta: ALTA }, ACTOR);
    await crearVivienda(db, { id: 'v18b', etapa: '1', bloque: '4', casa: '18B', estado: 'ACTIVA', fechaAlta: ALTA }, ACTOR);

    expect(codigoVivienda('1', '4', '18B')).toBe('E1B4C18B');
    expect(await contar(db, 'viviendas')).toBe(2);
  });

  it('no admite dos viviendas con la misma etapa, bloque y casa', async () => {
    await crearVivienda(db, { id: 'v1', etapa: '1', bloque: 'A', casa: '18', estado: 'ACTIVA', fechaAlta: ALTA }, ACTOR);
    await expect(crearVivienda(db, {
      id: 'v2', etapa: '1', bloque: 'A', casa: '18', estado: 'ACTIVA', fechaAlta: ALTA,
    }, ACTOR)).rejects.toThrow(/UNIQUE/i);
  });
});

describe('mensajes', () => {
  it('olvida el media_id al procesar el mensaje', async () => {
    await registrarMensaje(db, {
      messageId: 'wamid.1', telefono: '+50400000000', tipo: 'image',
      mediaId: 'media-123', estado: 'RECIBIDO', recibidoEn: ALTA,
    });
    await olvidarMedia(db, 'wamid.1', ALTA);

    const { rows } = await db.execute("SELECT media_id FROM mensajes WHERE message_id = 'wamid.1'");
    expect(rows[0].media_id).toBeNull();
  });
});

describe('transacciones', () => {
  it('una reserva fallida no deja meses ni eventos a medias', async () => {
    await crearVivienda(db, { id: 'v1', etapa: '1', bloque: '4', casa: '18', estado: 'ACTIVA', fechaAlta: ALTA }, ACTOR);
    await crearPago(db, {
      id: 'p1', metodo: 'TRANSFERENCIA', viviendaId: 'v1', montoCentavos: CUOTA_CENTAVOS,
      estado: 'PENDIENTE_VERIFICACION', creadoEn: ALTA,
    }, ACTOR);
    await crearPago(db, {
      id: 'p2', metodo: 'TRANSFERENCIA', viviendaId: 'v1', montoCentavos: CUOTA_CENTAVOS * 3,
      estado: 'PENDIENTE_VERIFICACION', creadoEn: ALTA,
    }, ACTOR);

    await reservarMeses(db, {
      pagoId: 'p1', viviendaId: 'v1',
      meses: [{ periodo: '2026-10', montoCentavos: CUOTA_CENTAVOS }], actor: ACTOR, creadoEn: ALTA,
    });
    const eventosAntes = await contar(db, 'eventos');

    // El segundo de los tres meses ya esta reservado por p1: la transaccion cae entera.
    await expect(reservarMeses(db, {
      pagoId: 'p2',
      viviendaId: 'v1',
      meses: [
        { periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS },
        { periodo: '2026-10', montoCentavos: CUOTA_CENTAVOS },
        { periodo: '2026-11', montoCentavos: CUOTA_CENTAVOS },
      ],
      actor: ACTOR,
      creadoEn: ALTA,
    })).rejects.toThrow(/UNIQUE/i);

    const { rows } = await db.execute("SELECT periodo FROM pago_meses WHERE pago_id = 'p2'");
    expect(rows).toHaveLength(0);
    expect(await contar(db, 'eventos')).toBe(eventosAntes);
  });

  it('verificar y emitir el recibo pueden ir en la misma transaccion', async () => {
    await crearVivienda(db, { id: 'v1', etapa: '1', bloque: '4', casa: '18', estado: 'ACTIVA', fechaAlta: ALTA }, ACTOR);
    await crearPago(db, {
      id: 'p1', metodo: 'TRANSFERENCIA', viviendaId: 'v1', montoCentavos: CUOTA_CENTAVOS,
      estado: 'PENDIENTE_VERIFICACION', creadoEn: ALTA,
    }, ACTOR);
    await reservarMeses(db, {
      pagoId: 'p1', viviendaId: 'v1',
      meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }], actor: ACTOR, creadoEn: ALTA,
    });

    const numero = await enTransaccion(db, async (tx) => {
      await verificarPagoConMovimiento(tx, {
        pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA,
      }, ACTOR);
      return emitirRecibo(tx, { pagoId: 'p1', emitidoEn: ALTA, actor: ACTOR });
    });

    expect(formatoRecibo(numero)).toBe('REC-000001');
    const { rows } = await db.execute("SELECT estado FROM pago_meses WHERE pago_id = 'p1'");
    expect(rows[0].estado).toBe('PAGADO');
  });
});
