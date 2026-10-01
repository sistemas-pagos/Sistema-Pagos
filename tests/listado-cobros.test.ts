import { describe, expect, it } from 'vitest';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { filasDeCobro, opcionesDeFiltro } from '@/src/services/listado-cobros';

/**
 * Lo que el cobrador ve.
 *
 * La prueba que mas importa no es que los filtros filtren: es que en la fila
 * **no viaje nada que el cobrador no deba ver** — ni el nombre del
 * depositante, ni el telefono de otro vecino, ni el monto de otra casa
 * (invariante 12). Un dato que no sale de la capa de servicio no se puede
 * filtrar por accidente en una pantalla.
 */
const HOY = '2026-10';

function casa(overrides: Partial<HomeRecord> = {}): HomeRecord {
  return {
    id: 'v1', stage: '3', block: '2', house: '14',
    monthlyFee: 150, active: true, startDate: '2026-09-01',
    ...overrides,
  };
}

function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'p1', createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
    sourceMessageId: 'msg-1', phone: '50433330000', bank: 'BAC Honduras',
    depositor: 'Juan Pérez', amount: 150, transactionDate: '2026-10-02',
    reference: '412000004821', stage: '3', block: '2', house: '14',
    period: HOY, status: 'VERIFICADO', method: 'TRANSFERENCIA', fileHash: 'sha-1',
    ...overrides,
  };
}

describe('la fila que ve el cobrador', () => {
  it('no lleva depositante, telefono ni monto', () => {
    const [fila] = filasDeCobro([casa()], [pago()], HOY);

    expect(fila).toEqual({
      viviendaId: 'v1',
      codigo: 'E3B2C14',
      stage: '3',
      block: '2',
      house: '14',
      estado: 'PAGADO',
      metodo: 'TRANSFERENCIA',
      referencia: '412000004821',
      fechaPago: '2026-10-02',
    });

    expect(JSON.stringify(fila)).not.toContain('Juan');
    expect(JSON.stringify(fila)).not.toContain('50433330000');
  });

  /** Es justamente a la que hay que ir a tocarle la puerta. */
  it('una casa sin pagos aparece igual, como pendiente', () => {
    const [fila] = filasDeCobro([casa()], [], HOY);
    expect(fila).toMatchObject({ codigo: 'E3B2C14', estado: 'PENDIENTE' });
    expect(fila.metodo).toBeUndefined();
  });

  it('una casa dada de baja no aparece', () => {
    expect(filasDeCobro([casa({ active: false })], [], HOY)).toEqual([]);
  });

  it('el pago de otro mes no cuenta para este', () => {
    const [fila] = filasDeCobro([casa()], [pago({ period: '2026-09' })], HOY);
    expect(fila.estado).toBe('PENDIENTE');
  });

  it('un pago rechazado deja la casa pendiente otra vez', () => {
    const [fila] = filasDeCobro([casa()], [pago({ status: 'RECHAZADO' })], HOY);
    expect(fila.estado).toBe('PENDIENTE');
  });

  /** Con varios pagos manda el mejor estado: pagado le gana a en revisión. */
  it('pagado manda sobre los demas estados', () => {
    const [fila] = filasDeCobro([casa()], [
      pago({ id: 'p1', status: 'EN_REVISION' }),
      pago({ id: 'p2', status: 'EFECTIVO_COBRADO', method: 'EFECTIVO' }),
    ], HOY);

    expect(fila.estado).toBe('PAGADO');
    expect(fila.metodo).toBe('EFECTIVO');
  });
});

describe('los filtros', () => {
  const padron = [
    casa({ id: 'v1', stage: '3', block: '2', house: '14' }),
    casa({ id: 'v2', stage: '3', block: '2', house: '16' }),
    casa({ id: 'v3', stage: '4', block: '1', house: '1' }),
  ];

  it('se van acumulando hasta dejar una sola casa', () => {
    expect(filasDeCobro(padron, [], HOY, { stage: '3' })).toHaveLength(2);
    expect(filasDeCobro(padron, [], HOY, { stage: '3', house: '16' })).toHaveLength(1);
  });

  it('el de estado separa las que deben de las que no', () => {
    const pagos = [pago({ stage: '3', block: '2', house: '14' })];
    expect(filasDeCobro(padron, pagos, HOY, { estado: 'PAGADO' }).map((f) => f.codigo)).toEqual(['E3B2C14']);
    expect(filasDeCobro(padron, pagos, HOY, { estado: 'PENDIENTE' })).toHaveLength(2);
  });

  it('el de metodo separa efectivo de transferencia', () => {
    const pagos = [
      pago({ id: 'p1', house: '14', method: 'TRANSFERENCIA' }),
      pago({ id: 'p2', house: '16', method: 'EFECTIVO', status: 'EFECTIVO_COBRADO' }),
    ];
    expect(filasDeCobro(padron, pagos, HOY, { metodo: 'EFECTIVO' }).map((f) => f.codigo)).toEqual(['E3B2C16']);
  });

  /**
   * El caso de Eduardo: el vecino dice que ya pago y lee los ultimos digitos de
   * su comprobante. Tiene que encontrarse sin escribir la referencia entera.
   */
  it('la referencia se encuentra por los ultimos digitos', () => {
    const pagos = [pago()];
    expect(filasDeCobro(padron, pagos, HOY, { busqueda: '4821' }).map((f) => f.codigo)).toEqual(['E3B2C14']);
    expect(filasDeCobro(padron, pagos, HOY, { busqueda: '0000' })).toEqual([]);
  });

  it('tambien se puede buscar por el codigo de la vivienda', () => {
    expect(filasDeCobro(padron, [], HOY, { busqueda: 'e4b1c1' }).map((f) => f.codigo)).toEqual(['E4B1C1']);
  });

  it('las filas salen ordenadas por etapa, bloque y casa', () => {
    const desordenado = [padron[2], padron[1], padron[0]];
    expect(filasDeCobro(desordenado, [], HOY).map((f) => f.codigo)).toEqual(['E3B2C14', 'E3B2C16', 'E4B1C1']);
  });

  it('las opciones de las listas salen del padron, sin repetir', () => {
    expect(opcionesDeFiltro(padron)).toEqual({
      etapas: ['3', '4'],
      bloques: ['1', '2'],
      casas: ['1', '14', '16'],
    });
  });

  it('una casa de baja no aporta opciones a las listas', () => {
    const conBaja = [...padron, casa({ id: 'v4', stage: '9', block: '9', house: '9', active: false })];
    expect(opcionesDeFiltro(conBaja).etapas).toEqual(['3', '4']);
  });
});

/**
 * El cobro en efectivo, visible.
 *
 * `pagos.periodo` guarda un mes y `pago_meses` guarda todos. El listado
 * filtraba por el primero, asi que un cobro de varios meses solo aparecia en
 * el mas viejo: en los demas la casa seguia diciendo «sin pago este mes»
 * aunque estuviera pagada, y el cobrador iba a tocarle la puerta de nuevo.
 */
describe('los meses que un pago tiene tomados', () => {
  const sept = '2026-09';
  const oct = '2026-10';

  const enEfectivo = (overrides: Partial<PaymentRecord> = {}) =>
    pago({
      id: 'efectivo-1',
      method: 'EFECTIVO',
      status: 'EFECTIVO_COBRADO',
      reference: undefined,
      ...overrides,
    });

  it('marca pagado cada mes del cobro, no solo el primero', () => {
    const cobro = enEfectivo({ period: sept, periods: [sept, oct], amount: 300 });

    expect(filasDeCobro([casa()], [cobro], sept)[0].estado).toBe('PAGADO');
    expect(filasDeCobro([casa()], [cobro], oct)[0].estado).toBe('PAGADO');
  });

  it('sin pago_meses cae en period, que es lo unico que tiene el demo', () => {
    const cobro = enEfectivo({ period: oct, periods: [] });

    expect(filasDeCobro([casa()], [cobro], oct)[0].estado).toBe('PAGADO');
    expect(filasDeCobro([casa()], [cobro], sept)[0].estado).toBe('PENDIENTE');
  });

  it('un mes que el pago no tiene sigue pendiente', () => {
    const cobro = enEfectivo({ period: sept, periods: [sept] });

    expect(filasDeCobro([casa()], [cobro], oct)[0].estado).toBe('PENDIENTE');
  });

  it('un pago anulado no tapa ninguno de sus meses', () => {
    const cobro = enEfectivo({ period: sept, periods: [sept, oct], status: 'ANULADO' });

    expect(filasDeCobro([casa()], [cobro], sept)[0].estado).toBe('PENDIENTE');
    expect(filasDeCobro([casa()], [cobro], oct)[0].estado).toBe('PENDIENTE');
  });
});
