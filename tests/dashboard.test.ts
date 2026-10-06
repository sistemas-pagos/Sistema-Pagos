import { describe, expect, it } from 'vitest';
import { DEMO_HOMES, DEMO_PAYMENTS, DEMO_PERIOD } from '@/src/demo/data';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { buildDashboardSnapshot } from '@/src/services/dashboard';
import { MemoryPaymentStore } from '@/src/storage/memory';

describe('dashboard snapshot', () => {
  it('keeps duplicate payments out of collection totals and separates monthly collection states', async () => {
    const store = new MemoryPaymentStore({ homes: DEMO_HOMES, payments: DEMO_PAYMENTS });
    const snapshot = await buildDashboardSnapshot(store, DEMO_PERIOD);
    expect(snapshot.totalHomes).toBe(12);
    expect(snapshot.paidHomes).toBe(2);
    expect(snapshot.verifyingHomes).toBe(1);
    expect(snapshot.reviewHomes).toBe(1);
    expect(snapshot.pendingHomes).toBe(8);
    expect(snapshot.duplicates).toHaveLength(1);
    expect(snapshot.receivedAmount).toBe(775);
    expect(snapshot.verifiedAmount).toBe(300);
    expect(snapshot.pendingAmount).toBe(1500);
    expect(snapshot.unidentifiedAmount).toBe(150);
    expect(snapshot.blocks.reduce((total, block) => total + block.collected, 0)).toBe(300);
    expect(snapshot.payments.find((payment) => payment.id === 'pay-demo-001')?.monthlyFee).toBe(150);
    expect(snapshot.review.find((payment) => payment.id === 'pay-demo-005')?.reviewReason).toBe('amount_above_expected');
    expect(snapshot.monthlyStatus.find((row) => row.homeId === 'home-e1-b1-c1')?.status).toBe('POR_VERIFICAR');
    expect(snapshot.monthlyStatus.find((row) => row.homeId === 'home-e1-b2-c2')?.status).toBe('EN_REVISION');
    expect(snapshot.monthlyStatus.find((row) => row.homeId === 'home-e1-b4-c18')?.status).toBe('PAGADO');
  });

  it('does not count a payment assigned outside the active EBC master as a paid home', async () => {
    const external: PaymentRecord = {
      id: 'pay-external', createdAt: '2026-09-08T13:00:00.000Z', updatedAt: '2026-09-08T13:00:00.000Z',
      sourceMessageId: 'msg-external', phone: '50400000999', bank: 'BAC Honduras', amount: 150,
      reference: 'DEMOREF-EXTERNAL', stage: '9', block: '99', house: '99', period: DEMO_PERIOD, status: 'VERIFICADO', fileHash: 'hash-external',
    };
    const store = new MemoryPaymentStore({ homes: DEMO_HOMES, payments: [...DEMO_PAYMENTS, external] });
    const snapshot = await buildDashboardSnapshot(store, DEMO_PERIOD);
    expect(snapshot.totalHomes).toBe(12);
    expect(snapshot.paidHomes).toBe(2);
    expect(snapshot.receivedAmount).toBe(925);
    expect(snapshot.pendingAmount).toBe(1500);
    expect(snapshot.blocks.reduce((total, block) => total + block.collected, 0)).toBe(300);
    expect(snapshot.payments.find((payment) => payment.id === 'pay-external')?.monthlyFee).toBeUndefined();
  });

  it('keeps identical block and house numbers separate across stages', async () => {
    const homes: HomeRecord[] = [
      { id: 'e1', stage: '1', block: '4', house: '18', monthlyFee: 150, active: true },
      { id: 'e2', stage: '2', block: '4', house: '18', monthlyFee: 150, active: true },
    ];
    const paid: PaymentRecord = {
      id: 'p1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceMessageId: 'm1',
      phone: '50400000000', bank: 'BAC Honduras', amount: 150, stage: '1', block: '4', house: '18',
      period: DEMO_PERIOD, status: 'VERIFICADO', fileHash: 'h1',
    };
    const snapshot = await buildDashboardSnapshot(new MemoryPaymentStore({ homes, payments: [paid] }), DEMO_PERIOD);
    expect(snapshot.paidHomes).toBe(1);
    expect(snapshot.pendingHomes).toBe(1);
    expect(snapshot.blocks).toHaveLength(2);
  });

  it('classifies a received but unverified home as por verificar, not paid or pending', async () => {
    const homes: HomeRecord[] = [
      { id: 'e1', stage: '1', block: '1', house: '1', monthlyFee: 150, active: true },
    ];
    const received: PaymentRecord = {
      id: 'p-received', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceMessageId: 'm-received',
      phone: '50400000000', bank: 'BAC Honduras', amount: 150, stage: '1', block: '1', house: '1',
      period: DEMO_PERIOD, status: 'PENDIENTE_VERIFICACION', fileHash: 'h-received',
    };
    const snapshot = await buildDashboardSnapshot(new MemoryPaymentStore({ homes, payments: [received] }), DEMO_PERIOD);
    expect(snapshot.receivedAmount).toBe(150);
    expect(snapshot.verifiedAmount).toBe(0);
    expect(snapshot.paidHomes).toBe(0);
    expect(snapshot.verifyingHomes).toBe(1);
    expect(snapshot.reviewHomes).toBe(0);
    expect(snapshot.pendingHomes).toBe(0);
    expect(snapshot.pendingAmount).toBe(150);
    expect(snapshot.blocks[0]?.collected).toBe(0);
  });

  it('includes a deactivated home in historical periods covered by its end date', async () => {
    const formerHome: HomeRecord = {
      id: 'home-former', stage: '1', block: '9', house: '1', monthlyFee: 150, active: false,
      startDate: '2026-01-01', endDate: '2026-08-20',
    };
    const store = new MemoryPaymentStore({ homes: [formerHome] });
    expect((await buildDashboardSnapshot(store, '2026-08')).totalHomes).toBe(1);
    expect((await buildDashboardSnapshot(store, '2026-09')).totalHomes).toBe(0);
  });
});

/**
 * El caso de Eduardo: el listado decia 2 pagadas y el dashboard 1.
 *
 * `pagos.periodo` guarda un mes y `pago_meses` guarda todos. El dashboard
 * filtraba por la columna; el listado de cobros ya miraba la tabla. Un cobro
 * en efectivo anterior al arreglo que la escribe quedo con `periodo` vacio, asi
 * que el dashboard no lo contaba y las dos pantallas se contradecian con la
 * plata de una casa real de por medio.
 */
describe('las dos pantallas cuentan lo mismo', () => {
  const PERIODO = '2026-09';

  const casa = (house: string): HomeRecord => ({
    id: `home-e3-b32-c${house}`, stage: '3', block: '32', house,
    monthlyFee: 150, active: true, startDate: '2026-09-01',
  });

  const cobro = (id: string, house: string, overrides: Partial<PaymentRecord> = {}): PaymentRecord => ({
    id, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
    sourceMessageId: '', phone: '', bank: '', amount: 150, transactionDate: '2026-10-01',
    stage: '3', block: '32', house, period: PERIODO, status: 'EFECTIVO_COBRADO',
    method: 'EFECTIVO', fileHash: '', ...overrides,
  });

  it('cuenta un cobro cuyos meses solo estan en pago_meses', async () => {
    const store = new MemoryPaymentStore({
      homes: [casa('1'), casa('2')],
      // El viejo: sin `periodo`, solo con sus meses reservados.
      payments: [
        cobro('p-viejo', '1', { period: '', periods: [PERIODO] }),
        cobro('p-nuevo', '2'),
      ],
    });

    const snapshot = await buildDashboardSnapshot(store, PERIODO);

    expect(snapshot.paidHomes).toBe(2);
    expect(snapshot.pendingHomes).toBe(0);
    expect(snapshot.receivedAmount).toBe(300);
  });

  it('cuenta los dos meses de un cobro que cubre varios', async () => {
    const store = new MemoryPaymentStore({
      homes: [casa('1')],
      payments: [cobro('p-dos-meses', '1', { period: PERIODO, periods: [PERIODO, '2026-10'], amount: 300 })],
    });

    expect((await buildDashboardSnapshot(store, PERIODO)).paidHomes).toBe(1);
    expect((await buildDashboardSnapshot(store, '2026-10')).paidHomes).toBe(1);
  });
});

/**
 * Las viviendas inactivas se cuentan aparte y en ningun otro lado.
 *
 * Eduardo: «en el monto esperado solo deberia de sumar lo de las cuentas
 * activas; si esta inactiva no deberia de sumar en nada mas que en el campo de
 * viviendas inactivas». Una casa que no paga el servicio no debe nada, asi que
 * contarla como pendiente inflaria la deuda con plata que nadie tiene que pagar.
 */
describe('viviendas inactivas en el dashboard', () => {
  const PERIODO = '2026-09';

  const vivienda = (house: string, active: boolean): HomeRecord => ({
    id: `home-e1-b1-c${house}`, stage: '1', block: '1', house,
    monthlyFee: 150, active, startDate: '2026-09-01',
  });

  it('no suman en el total, ni en lo esperado, ni en lo pendiente', async () => {
    const store = new MemoryPaymentStore({
      homes: [vivienda('1', true), vivienda('2', true), vivienda('3', false)],
    });

    const snapshot = await buildDashboardSnapshot(store, PERIODO);

    expect(snapshot.inactiveHomes).toBe(1);
    expect(snapshot.totalHomes).toBe(2);
    expect(snapshot.expectedAmount).toBe(300);
    expect(snapshot.pendingAmount).toBe(300);
    expect(snapshot.pendingHomes).toBe(2);
  });

  it('sin inactivas el campo queda en cero', async () => {
    const store = new MemoryPaymentStore({ homes: [vivienda('1', true)] });

    expect((await buildDashboardSnapshot(store, PERIODO)).inactiveHomes).toBe(0);
  });

  /** Una casa dada de alta despues no se cuenta ni como inactiva. */
  it('una casa que todavia no existia no se cuenta', async () => {
    const store = new MemoryPaymentStore({
      homes: [{ ...vivienda('9', false), startDate: '2026-12-01' }],
    });

    expect((await buildDashboardSnapshot(store, PERIODO)).inactiveHomes).toBe(0);
  });
});

/**
 * La plata de una casa inactiva no suma **mientras** lo este.
 *
 * Eduardo: «no deberia de sumar si esta inactivo, pero una vez hace el deposito
 * o entrega en efectivo y el admin lo deje como activo si suma, por que esta
 * activo, y de ahi en adelante esa cuenta ya queda activa».
 *
 * O sea: la plata no desaparece, espera. Lo que no puede hacer es engordar el
 * recaudado de un mes en el que esa casa no estaba cobrando. La prueba que
 * importa es la segunda: activar la casa tiene que hacer aparecer su pago sin
 * tocar el pago.
 */
describe('la plata de una casa inactiva', () => {
  const PERIODO = '2026-09';

  const vivienda = (house: string, active: boolean): HomeRecord => ({
    id: `home-e1-b1-c${house}`, stage: '1', block: '1', house,
    monthlyFee: 150, active, startDate: '2026-09-01',
  });

  const suPago = (house: string): PaymentRecord => ({
    id: `pago-${house}`, createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T10:00:00.000Z',
    sourceMessageId: '', phone: '', bank: 'BAC Honduras', amount: 150, transactionDate: '2026-09-10',
    stage: '1', block: '1', house, period: PERIODO, status: 'EN_REVISION',
    reviewReason: 'home_inactive', fileHash: '',
  });

  it('no suma en recibido mientras la casa esta inactiva', async () => {
    const store = new MemoryPaymentStore({
      homes: [vivienda('1', true), vivienda('2', false)],
      payments: [suPago('2')],
    });

    const snapshot = await buildDashboardSnapshot(store, PERIODO);

    expect(snapshot.receivedAmount).toBe(0);
    expect(snapshot.inactiveHomes).toBe(1);
  });

  /** El mismo pago, la misma casa: lo unico que cambia es que el admin la activo. */
  it('suma en cuanto el admin la deja activa, sin tocar el pago', async () => {
    const antes = new MemoryPaymentStore({ homes: [vivienda('2', false)], payments: [suPago('2')] });
    const despues = new MemoryPaymentStore({ homes: [vivienda('2', true)], payments: [suPago('2')] });

    expect((await buildDashboardSnapshot(antes, PERIODO)).receivedAmount).toBe(0);
    expect((await buildDashboardSnapshot(despues, PERIODO)).receivedAmount).toBe(150);
  });

  /**
   * Una vivienda que no esta en el padron es otro problema, y su plata si se ve:
   * esconderla dejaria dinero existiendo que nadie cuadra.
   */
  it('la de una vivienda que no existe en el padron si suma', async () => {
    const store = new MemoryPaymentStore({
      homes: [vivienda('1', true)],
      payments: [{ ...suPago('99'), reviewReason: 'receipt_home_not_in_master' }],
    });

    expect((await buildDashboardSnapshot(store, PERIODO)).receivedAmount).toBe(150);
  });
});
