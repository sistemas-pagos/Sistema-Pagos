import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, PLANTILLA, contar, nuevaBaseDePrueba } from './helpers/turso-test-db';
import { cajasPendientes, cerrarCaja, cobrosSinEntregar } from '@/src/storage/cierre-caja';
import { cobradoSinEntregar, registrarCobroEnEfectivo, registrarCobroEnRevision } from '@/src/storage/efectivo';
import { dejarNota, notasAbiertas, resolverNota } from '@/src/storage/notas';
import { crearVivienda } from '@/src/storage/turso';
import { crearUsuario } from '@/src/storage/usuarios';

/**
 * Cerrar la caja y la bandeja de notas.
 *
 * Registrar el cobro es la mitad del ciclo; la otra mitad es que esa plata
 * llegue a la tesoreria. Sin el cierre, el sistema solo sabe que el cobrador
 * **dijo** que cobro — que es el riesgo numero uno del efectivo.
 */
const EN = '2026-10-15T12:00:00.000Z';
let db: Client;

const base = {
  viviendaId: 'v1', cobradorId: 'u-cobrador', aceptaWhatsapp: false,
  fechaPago: '2026-10-15', plantilla: PLANTILLA, creadoEn: EN,
};

beforeEach(async () => {
  db = await nuevaBaseDePrueba();
  await crearUsuario(db, { id: 'u-cobrador', nombre: 'cobrador', rol: 'COBRADOR' }, ACTOR, EN);
  await crearUsuario(db, { id: 'u-tesorero', nombre: 'tesorero', rol: 'TESORERO' }, ACTOR, EN);
  await crearVivienda(db, {
    id: 'v1', etapa: '3', bloque: '2', casa: '14', estado: 'ACTIVA', fechaAlta: '2026-09-01T00:00:00.000Z',
  }, ACTOR);
});

afterEach(() => { db.close(); });

async function unCobro(pagoId: string, periodo: string) {
  return registrarCobroEnEfectivo(db, {
    ...base, pagoId, meses: [{ periodo, montoCentavos: 15_000 }],
  }, ACTOR);
}

describe('cerrar la caja', () => {
  const cierre = {
    id: 'cc-1', cobradorId: 'u-cobrador', tesoreroId: 'u-tesorero',
    montoEsperadoCentavos: 30_000, montoEntregadoCentavos: 30_000, creadoEn: EN,
  };

  it('deja los cobros verificados y sin nada pendiente de entregar', async () => {
    await unCobro('p1', '2026-09');
    await unCobro('p2', '2026-10');

    const resultado = await cerrarCaja(db, cierre, ACTOR);

    expect(resultado).toEqual({ pagosCerrados: 2, diferenciaCentavos: 0 });
    const estados = await db.execute("SELECT estado FROM pagos WHERE metodo = 'EFECTIVO'");
    expect(estados.rows.every((fila) => fila.estado === 'VERIFICADO')).toBe(true);
    expect(await cobradoSinEntregar(db, 'u-cobrador')).toMatchObject({ totalCentavos: 0, cobros: 0 });
  });

  /** El vecino ya tiene su recibo desde que pago (invariante 10). */
  it('no emite un segundo recibo para el mismo pago', async () => {
    await unCobro('p1', '2026-09');
    expect(await contar(db, 'recibos')).toBe(1);

    await cerrarCaja(db, { ...cierre, montoEsperadoCentavos: 15_000, montoEntregadoCentavos: 15_000 }, ACTOR);

    expect(await contar(db, 'recibos')).toBe(1);
  });

  /**
   * Esa plata se entrego igual, pero el problema que la puso en revision sigue
   * ahi. Cerrarla como verificada seria usar la entrega del dinero para
   * resolver algo que no tiene nada que ver.
   */
  it('lo que estaba en revision se entrega pero no se verifica', async () => {
    await unCobro('p1', '2026-09');
    await registrarCobroEnRevision(db, {
      ...base, pagoId: 'p2', meses: [{ periodo: '2026-09', montoCentavos: 15_000 }],
      motivo: 'ya habia pagado',
    }, ACTOR);

    const resultado = await cerrarCaja(db, cierre, ACTOR);

    expect(resultado.pagosCerrados).toBe(2);
    const revision = await db.execute("SELECT estado, cierre_caja_id FROM pagos WHERE id = 'p2'");
    expect(revision.rows[0]).toMatchObject({ estado: 'EN_REVISION', cierre_caja_id: 'cc-1' });
  });

  /** Un faltante que se tapa no es un faltante: es un dato perdido. */
  it('la diferencia se guarda tal cual, no se corrige', async () => {
    await unCobro('p1', '2026-09');
    await unCobro('p2', '2026-10');

    const resultado = await cerrarCaja(db, { ...cierre, montoEntregadoCentavos: 29_000 }, ACTOR);

    expect(resultado.diferenciaCentavos).toBe(-1_000);
    const guardado = await db.execute("SELECT monto_esperado_centavos, monto_entregado_centavos FROM cierres_caja");
    expect(guardado.rows[0]).toMatchObject({ monto_esperado_centavos: 30_000, monto_entregado_centavos: 29_000 });
  });

  /** Lo impide la base desde la 001, que es donde no se puede olvidar. */
  it('nadie recibe lo que el mismo cobro', async () => {
    await unCobro('p1', '2026-09');

    await expect(cerrarCaja(db, { ...cierre, tesoreroId: 'u-cobrador' }, ACTOR))
      .rejects.toThrow(/CHECK|constraint/i);
  });

  it('un cierre no toca lo que ya se habia cerrado antes', async () => {
    await unCobro('p1', '2026-09');
    await cerrarCaja(db, { ...cierre, montoEsperadoCentavos: 15_000, montoEntregadoCentavos: 15_000 }, ACTOR);

    await unCobro('p2', '2026-10');
    const segundo = await cerrarCaja(db, {
      ...cierre, id: 'cc-2', montoEsperadoCentavos: 15_000, montoEntregadoCentavos: 15_000,
    }, ACTOR);

    expect(segundo.pagosCerrados).toBe(1);
    const primero = await db.execute("SELECT cierre_caja_id FROM pagos WHERE id = 'p1'");
    expect(primero.rows[0].cierre_caja_id).toBe('cc-1');
  });

  it('el evento no dice montos', async () => {
    await unCobro('p1', '2026-09');
    await cerrarCaja(db, { ...cierre, montoEsperadoCentavos: 15_000, montoEntregadoCentavos: 15_000 }, ACTOR);

    const { rows } = await db.execute("SELECT despues_json FROM eventos WHERE accion = 'CERRAR'");
    expect(String(rows[0].despues_json)).not.toContain('15000');
  });
});

describe('las notas del cobrador', () => {
  beforeEach(async () => { await unCobro('p1', '2026-09'); });

  it('la nota queda abierta y aparece en la bandeja con su vivienda', async () => {
    await dejarNota(db, {
      id: 'n1', pagoId: 'p1', autorId: 'u-cobrador',
      texto: 'El señor dice que su hijo ya habia transferido.', creadaEn: EN,
    });

    const [nota] = await notasAbiertas(db);
    expect(nota).toMatchObject({
      pagoId: 'p1', autorId: 'u-cobrador', vivienda: 'E3B2C14', estadoDelPago: 'EFECTIVO_COBRADO',
    });
  });

  it('una nota vacia no se guarda', async () => {
    await expect(dejarNota(db, {
      id: 'n1', pagoId: 'p1', autorId: 'u-cobrador', texto: '   ', creadaEn: EN,
    })).rejects.toThrow('nota_vacia');
  });

  /** Se cierra, no se borra: su texto explica por que el pago quedo como quedo. */
  it('resolverla la saca de la bandeja pero conserva el texto', async () => {
    await dejarNota(db, { id: 'n1', pagoId: 'p1', autorId: 'u-cobrador', texto: 'algo raro', creadaEn: EN });

    expect(await resolverNota(db, { id: 'n1', resueltaPor: 'u-tesorero', en: EN })).toBe(true);
    expect(await notasAbiertas(db)).toEqual([]);

    const { rows } = await db.execute("SELECT texto, estado, resuelta_por FROM notas_pago WHERE id = 'n1'");
    expect(rows[0]).toMatchObject({ texto: 'algo raro', estado: 'RESUELTA', resuelta_por: 'u-tesorero' });
  });

  it('resolver dos veces la misma nota no hace nada la segunda', async () => {
    await dejarNota(db, { id: 'n1', pagoId: 'p1', autorId: 'u-cobrador', texto: 'algo', creadaEn: EN });

    expect(await resolverNota(db, { id: 'n1', resueltaPor: 'u-tesorero', en: EN })).toBe(true);
    expect(await resolverNota(db, { id: 'n1', resueltaPor: 'u-tesorero', en: EN })).toBe(false);
  });

  it('el evento no lleva el texto, que puede nombrar al vecino', async () => {
    await dejarNota(db, {
      id: 'n1', pagoId: 'p1', autorId: 'u-cobrador', texto: 'Don Ramon dijo que ya pago', creadaEn: EN,
    });

    const { rows } = await db.execute("SELECT despues_json FROM eventos WHERE entidad = 'notas_pago'");
    expect(String(rows[0].despues_json)).not.toContain('Ramon');
  });

  it('la bandeja saca las mas viejas primero', async () => {
    await unCobro('p2', '2026-10');
    await dejarNota(db, { id: 'n2', pagoId: 'p2', autorId: 'u-cobrador', texto: 'nueva', creadaEn: '2026-10-16T12:00:00.000Z' });
    await dejarNota(db, { id: 'n1', pagoId: 'p1', autorId: 'u-cobrador', texto: 'vieja', creadaEn: EN });

    expect((await notasAbiertas(db)).map((nota) => nota.id)).toEqual(['n1', 'n2']);
  });
});

describe('lo que el tesorero ve antes de contar', () => {
  const cierre = {
    id: 'cc-1', cobradorId: 'u-cobrador', tesoreroId: 'u-tesorero',
    montoEsperadoCentavos: 15_000, montoEntregadoCentavos: 15_000, creadoEn: EN,
  };

  it('la caja pendiente trae el nombre, el total y lo que esta en revision', async () => {
    await unCobro('p1', '2026-09');
    await registrarCobroEnRevision(db, {
      ...base, pagoId: 'p2', meses: [{ periodo: '2026-09', montoCentavos: 15_000 }],
      motivo: 'ya habia pagado',
    }, ACTOR);

    const [caja] = await cajasPendientes(db);

    expect(caja).toMatchObject({
      cobradorId: 'u-cobrador', nombre: 'cobrador', cobros: 2,
      totalCentavos: 30_000, enRevisionCentavos: 15_000,
    });
  });

  it('una caja cerrada desaparece de la lista', async () => {
    await unCobro('p1', '2026-09');
    await cerrarCaja(db, cierre, ACTOR);

    expect(await cajasPendientes(db)).toEqual([]);
  });

  /**
   * Lo que mide el riesgo del efectivo es el tiempo en la calle, no el monto:
   * ciento cincuenta lempiras de hace tres semanas preocupan mas que mil de ayer.
   */
  it('la lista sale con la caja mas vieja primero', async () => {
    await crearUsuario(db, { id: 'u-otro', nombre: 'otro', rol: 'COBRADOR' }, ACTOR, EN);
    await registrarCobroEnEfectivo(db, {
      ...base, pagoId: 'p-nuevo', cobradorId: 'u-otro',
      meses: [{ periodo: '2026-10', montoCentavos: 15_000 }], creadoEn: '2026-10-20T12:00:00.000Z',
    }, ACTOR);
    await unCobro('p-viejo', '2026-09');

    expect((await cajasPendientes(db)).map((caja) => caja.cobradorId)).toEqual(['u-cobrador', 'u-otro']);
  });

  /** Es contra el talonario del cobrador que se compara, papel contra pantalla. */
  it('el detalle trae el numero de recibo de cada cobro', async () => {
    await unCobro('p1', '2026-09');

    const [cobro] = await cobrosSinEntregar(db, 'u-cobrador');

    expect(cobro).toMatchObject({ pagoId: 'p1', vivienda: 'E3B2C14', estado: 'EFECTIVO_COBRADO', montoCentavos: 15_000 });
    expect(cobro.reciboNumero).toBeGreaterThan(0);
  });

  it('el cobro en revision aparece en el detalle aunque no tenga recibo', async () => {
    await registrarCobroEnRevision(db, {
      ...base, pagoId: 'p2', meses: [{ periodo: '2026-09', montoCentavos: 15_000 }],
      motivo: 'ya habia pagado',
    }, ACTOR);

    const [cobro] = await cobrosSinEntregar(db, 'u-cobrador');

    expect(cobro).toMatchObject({ pagoId: 'p2', estado: 'EN_REVISION' });
    expect(cobro.reciboNumero).toBeUndefined();
  });

  it('el detalle no mezcla lo de otro cobrador', async () => {
    await crearUsuario(db, { id: 'u-otro', nombre: 'otro', rol: 'COBRADOR' }, ACTOR, EN);
    await unCobro('p1', '2026-09');

    expect(await cobrosSinEntregar(db, 'u-otro')).toEqual([]);
  });
});
