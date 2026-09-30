import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, CUOTA_CENTAVOS, PLANTILLA, contar, nuevaBaseDePrueba } from './helpers/turso-test-db';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { CobroInvalido, mesesCobrables, mesesDeLaVivienda, seleccionarMeses } from '@/src/services/cobro-efectivo';
import { cobradoSinEntregar, registrarCobroEnEfectivo, registrarCobroEnRevision } from '@/src/storage/efectivo';
import { crearVivienda } from '@/src/storage/turso';
import { crearUsuario } from '@/src/storage/usuarios';

/**
 * El cobro en efectivo.
 *
 * Dos cosas se cuidan aca por encima del resto. La primera: el cobrador **no
 * escribe el monto** — marca meses y el total se calcula —, que es lo que hace
 * imposible un cobro incompleto. La segunda: cobrarle a una casa que ya pago
 * no puede emitir recibo ni mandarle nada al vecino, pero **si tiene que
 * quedar registrado**, porque el cobrador ya tiene esa plata en la mano.
 */
const HOY = new Date('2026-10-15T12:00:00.000Z');
const EN = '2026-10-15T12:00:00.000Z';

let db: Client;

const CASA: HomeRecord = {
  id: 'v1', stage: '3', block: '2', house: '14', monthlyFee: 150, active: true, startDate: '2026-09-01',
};

function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'p-otro', createdAt: EN, updatedAt: EN, sourceMessageId: 'msg-1', phone: '50400000001',
    bank: 'BAC Honduras', amount: 150, transactionDate: '2026-09-15', reference: '412000001',
    stage: '3', block: '2', house: '14', period: '2026-09', status: 'VERIFICADO', fileHash: 'sha-1',
    ...overrides,
  };
}

beforeEach(async () => {
  db = await nuevaBaseDePrueba();
  await crearUsuario(db, { id: 'u-cobrador', nombre: 'cobrador', rol: 'COBRADOR' }, ACTOR, EN);
  await crearVivienda(db, {
    id: 'v1', etapa: '3', bloque: '2', casa: '14', estado: 'ACTIVA', fechaAlta: '2026-09-01T00:00:00.000Z',
  }, ACTOR);
});

afterEach(() => { db.close(); });

describe('que meses se le pueden cobrar a una casa', () => {
  it('van del alta al mes en curso, nunca antes de septiembre de 2026', () => {
    expect(mesesDeLaVivienda(CASA, HOY)).toEqual(['2026-09', '2026-10']);
  });

  /** La deuda vieja es un SALDO_INICIAL, no meses (docs/PLAN.md, seccion 1). */
  it('un alta anterior al primer mes de servicio no agrega meses viejos', () => {
    const vieja = { ...CASA, startDate: '2024-01-01' };
    expect(mesesDeLaVivienda(vieja, HOY)).toEqual(['2026-09', '2026-10']);
  });

  it('no se cobra por adelantado: nada despues del mes en curso', () => {
    expect(mesesDeLaVivienda(CASA, new Date('2026-09-05T12:00:00.000Z'))).toEqual(['2026-09']);
  });

  it('una casa dada de alta despues del mes en curso no debe nada', () => {
    const nueva = { ...CASA, startDate: '2027-03-01' };
    expect(mesesDeLaVivienda(nueva, HOY)).toEqual([]);
  });

  /**
   * Se marcan en vez de omitirse: el cobrador tiene que poder decirle al vecino
   * «septiembre ya lo pagaste», que es el caso que esto viene a resolver.
   */
  it('el mes ya pagado se marca, no se esconde', () => {
    const cobrables = mesesCobrables(CASA, [pago()], HOY);
    expect(cobrables).toEqual([
      { periodo: '2026-09', montoCentavos: 15_000, yaPagado: true },
      { periodo: '2026-10', montoCentavos: 15_000, yaPagado: false },
    ]);
  });

  it('un pago rechazado libera el mes y vuelve a ser cobrable', () => {
    const cobrables = mesesCobrables(CASA, [pago({ status: 'RECHAZADO' })], HOY);
    expect(cobrables[0].yaPagado).toBe(false);
  });

  it('un comprobante sin verificar igual reserva el mes', () => {
    const cobrables = mesesCobrables(CASA, [pago({ status: 'PENDIENTE_VERIFICACION' })], HOY);
    expect(cobrables[0].yaPagado).toBe(true);
  });
});

describe('el total sale de los meses, no del teclado', () => {
  const cobrables = [
    { periodo: '2026-09', montoCentavos: 15_000, yaPagado: false },
    { periodo: '2026-10', montoCentavos: 20_000, yaPagado: false },
  ];

  /** La cuota puede cambiar (`cuotas.vigente_desde`): no es n x cuota de hoy. */
  it('cada mes cuesta lo suyo, no se multiplica por la cuota actual', () => {
    expect(seleccionarMeses(cobrables, ['2026-09', '2026-10']).totalCentavos).toBe(35_000);
  });

  it('los meses salen ordenados del mas viejo al mas nuevo', () => {
    const { meses } = seleccionarMeses(cobrables, ['2026-10', '2026-09']);
    expect(meses.map((mes) => mes.periodo)).toEqual(['2026-09', '2026-10']);
  });

  /**
   * Que la pantalla no lo ofrezca no alcanza: el formulario viaja por HTTP y
   * puede llegar cualquier cosa.
   */
  it('rechaza un mes ya pagado aunque llegue en el formulario', () => {
    const conPagado = [{ periodo: '2026-09', montoCentavos: 15_000, yaPagado: true }];
    expect(() => seleccionarMeses(conPagado, ['2026-09'])).toThrow(CobroInvalido);
  });

  it('rechaza un mes que no es de esta vivienda, repetidos, y ninguno', () => {
    expect(() => seleccionarMeses(cobrables, ['2026-08'])).toThrow(CobroInvalido);
    expect(() => seleccionarMeses(cobrables, ['2026-09', '2026-09'])).toThrow(CobroInvalido);
    expect(() => seleccionarMeses(cobrables, [])).toThrow(CobroInvalido);
  });
});

describe('registrar el cobro', () => {
  const base = {
    pagoId: 'p-efectivo', viviendaId: 'v1', cobradorId: 'u-cobrador',
    telefono: '+50433330000', aceptaWhatsapp: true,
    fechaPago: '2026-10-15', plantilla: PLANTILLA, creadoEn: EN,
  };

  it('deja el pago cobrado, el mes pagado, el recibo emitido y el envio encolado', async () => {
    const { reciboNumero, montoCentavos } = await registrarCobroEnEfectivo(db, {
      ...base, meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }],
    }, ACTOR);

    expect(reciboNumero).toBe(1);
    expect(montoCentavos).toBe(CUOTA_CENTAVOS);

    const pagoGuardado = await db.execute("SELECT estado, metodo, cobrador_id FROM pagos WHERE id = 'p-efectivo'");
    expect(pagoGuardado.rows[0]).toMatchObject({ estado: 'EFECTIVO_COBRADO', metodo: 'EFECTIVO', cobrador_id: 'u-cobrador' });

    const mes = await db.execute("SELECT estado FROM pago_meses WHERE pago_id = 'p-efectivo'");
    expect(mes.rows[0].estado).toBe('PAGADO');
    expect(await contar(db, 'envios')).toBe(1);
  });

  it('dos meses suman en un solo pago y un solo recibo', async () => {
    const { montoCentavos } = await registrarCobroEnEfectivo(db, {
      ...base,
      meses: [
        { periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS },
        { periodo: '2026-10', montoCentavos: CUOTA_CENTAVOS },
      ],
    }, ACTOR);

    expect(montoCentavos).toBe(CUOTA_CENTAVOS * 2);
    expect(await contar(db, 'recibos')).toBe(1);
    expect(await contar(db, 'pago_meses')).toBe(2);
  });

  /** Sin telefono el pago vale igual; el recibo aparece como no entregado. */
  it('sin telefono se registra pero no se encola envio', async () => {
    await registrarCobroEnEfectivo(db, {
      ...base, telefono: undefined, aceptaWhatsapp: false,
      meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }],
    }, ACTOR);

    expect(await contar(db, 'recibos')).toBe(1);
    expect(await contar(db, 'envios')).toBe(0);
  });

  /** Tener el numero no da derecho a escribirle (invariante 13). */
  it('con telefono pero sin consentimiento tampoco se encola', async () => {
    await registrarCobroEnEfectivo(db, {
      ...base, aceptaWhatsapp: false,
      meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }],
    }, ACTOR);

    expect(await contar(db, 'envios')).toBe(0);
  });

  it('el evento no dice el telefono ni el monto', async () => {
    await registrarCobroEnEfectivo(db, {
      ...base, meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }],
    }, ACTOR);

    const { rows } = await db.execute("SELECT despues_json FROM eventos WHERE accion = 'COBRO_EFECTIVO'");
    const despues = String(rows[0].despues_json);
    expect(despues).not.toContain('50433330000');
    expect(despues).not.toContain('15000');
  });

  /** Si el mes ya estaba tomado no puede quedar nada a medias. */
  it('un mes ya tomado hace fallar el cobro entero, sin dejar recibo huerfano', async () => {
    await registrarCobroEnEfectivo(db, {
      ...base, meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }],
    }, ACTOR);

    await expect(registrarCobroEnEfectivo(db, {
      ...base, pagoId: 'p-dos', meses: [{ periodo: '2026-09', montoCentavos: CUOTA_CENTAVOS }],
    }, ACTOR)).rejects.toThrow(/UNIQUE/i);

    expect(await contar(db, 'recibos')).toBe(1);
    expect(await contar(db, 'pagos')).toBe(1);
  });
});

describe('la casa que ya pago', () => {
  const enRevision = {
    pagoId: 'p-revision', viviendaId: 'v1', cobradorId: 'u-cobrador',
    telefono: '+50433330000', aceptaWhatsapp: true, fechaPago: '2026-10-15', creadoEn: EN,
    meses: [{ periodo: '2026-09', montoCentavos: 15_000 }],
    motivo: 'El vecino ya me habia dado los L150 en la puerta',
  };

  /**
   * Lo que no se puede hacer es no registrarlo: el cobrador ya tiene la plata,
   * y dejarla fuera del sistema es peor que anotarla rara.
   */
  it('se registra en revision, sin tomar el mes, sin recibo y sin avisarle al vecino', async () => {
    const { montoCentavos } = await registrarCobroEnRevision(db, enRevision, ACTOR);

    expect(montoCentavos).toBe(15_000);
    const guardado = await db.execute("SELECT estado FROM pagos WHERE id = 'p-revision'");
    expect(guardado.rows[0].estado).toBe('EN_REVISION');

    expect(await contar(db, 'recibos')).toBe(0);
    expect(await contar(db, 'envios')).toBe(0);
    expect(await contar(db, 'pago_meses')).toBe(0);
  });
});

describe('lo que el cobrador tiene que entregar', () => {
  const base = {
    viviendaId: 'v1', cobradorId: 'u-cobrador', aceptaWhatsapp: false,
    fechaPago: '2026-10-15', plantilla: PLANTILLA, creadoEn: EN,
  };

  /** Esa plata tambien esta en su bolsillo: dejarla fuera le haria faltar dinero. */
  it('suma los cobros en revision, no solo los buenos', async () => {
    await registrarCobroEnEfectivo(db, {
      ...base, pagoId: 'p-uno', meses: [{ periodo: '2026-09', montoCentavos: 15_000 }],
    }, ACTOR);
    await registrarCobroEnRevision(db, {
      ...base, pagoId: 'p-dos', meses: [{ periodo: '2026-09', montoCentavos: 15_000 }],
      motivo: 'ya habia pagado',
    }, ACTOR);

    expect(await cobradoSinEntregar(db, 'u-cobrador')).toEqual({
      totalCentavos: 30_000,
      cobros: 2,
      enRevisionCentavos: 15_000,
    });
  });

  it('un cobrador sin cobros no debe nada', async () => {
    expect(await cobradoSinEntregar(db, 'u-cobrador')).toEqual({
      totalCentavos: 0, cobros: 0, enRevisionCentavos: 0,
    });
  });
});
