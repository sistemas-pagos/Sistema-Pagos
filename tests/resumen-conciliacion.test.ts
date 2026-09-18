import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import type { PaymentRecord } from '@/src/domain/types';
import { resumirConciliacion, textoDelResumen } from '@/src/domain/resumen-conciliacion';
import { type BankMovement, planReconciliation, reconcilePendingPayments } from '@/src/services/reconciliation';
import { MemoryPaymentStore } from '@/src/storage/memory';

function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
    sourceMessageId: 'msg-1', phone: '+50400000001', bank: 'BAC Honduras', amount: 150,
    transactionDate: '2026-09-02', reference: '412000001', stage: '1', block: '4', house: '18',
    period: '2026-09', status: 'PENDIENTE_VERIFICACION', fileHash: 'hash-1', ...overrides,
  };
}

function deposito(overrides: Partial<BankMovement> = {}): BankMovement {
  return { id: 'mov-1', bank: 'BAC Honduras', reference: '412000001', amount: 150, transactionDate: '2026-09-02', ...overrides };
}

beforeEach(() => {
  delete process.env.EXPECTED_PAYMENT_AMOUNT;
  resetEnvForTests();
});

describe('lo que el tesorero ve antes de confirmar', () => {
  it('cuenta los pagos que se verificarian y cuanto suman', () => {
    const pagos = [pago(), pago({ id: 'pay-2', sourceMessageId: 'msg-2', fileHash: 'h2', reference: '412000002', house: '19' })];
    const depositos = [deposito(), deposito({ id: 'mov-2', reference: '412000002' })];

    const resumen = resumirConciliacion(planReconciliation(pagos, depositos), depositos);

    expect(resumen.verificaria).toBe(2);
    expect(resumen.verificariaCentavos).toBe(30000);
  });

  /**
   * Un deposito que nadie reclama es plata que ya esta en la cuenta y no se
   * sabe de que casa es. No lo resuelve el sistema: lo sale a buscar una
   * persona, y por eso tiene que estar en el resumen y no escondido.
   */
  it('cuenta aparte el dinero que entro sin comprobante', () => {
    const depositos = [deposito(), deposito({ id: 'mov-2', reference: '999999999', amount: 300 })];

    const resumen = resumirConciliacion(planReconciliation([pago()], depositos), depositos);

    expect(resumen.sinComprobante).toBe(1);
    expect(resumen.sinComprobanteCentavos).toBe(30000);
  });

  /** El comprobante llego pero el banco no lo respalda (invariante 2). */
  it('cuenta los comprobantes que el extracto no respalda', () => {
    const resumen = resumirConciliacion(planReconciliation([pago()], []), []);

    expect(resumen.sinDeposito).toBe(1);
    expect(resumen.verificaria).toBe(0);
  });

  it('cuenta los que quedan para una persona', () => {
    const conMontoRaro = pago({ amount: 175 });
    const depositos = [deposito({ amount: 175 })];

    const resumen = resumirConciliacion(planReconciliation([conMontoRaro], depositos), depositos);

    expect(resumen.aRevision).toBe(1);
    expect(resumen.verificaria).toBe(0);
  });

  /**
   * Un deposito cuyo comprobante termina en revision no es "sin comprobante":
   * el dinero ya tiene duenio conocido y mandarlo a buscar seria trabajo
   * inventado.
   */
  it('no llama huerfano a un deposito cuyo comprobante quedo en revision', () => {
    const depositos = [deposito({ amount: 175 })];

    const resumen = resumirConciliacion(planReconciliation([pago({ amount: 175 })], depositos), depositos);

    expect(resumen.sinComprobante).toBe(0);
  });

  /** Un deposito ya conciliado en una corrida anterior tampoco es huerfano. */
  it('no vuelve a marcar un deposito que ya verifico un pago', () => {
    const yaVerificado = pago({ status: 'VERIFICADO', bankMovementId: 'mov-1' });
    const depositos = [deposito()];

    const resumen = resumirConciliacion(planReconciliation([yaVerificado], depositos), depositos);

    expect(resumen.sinComprobante).toBe(0);
    expect(resumen.verificaria).toBe(0);
  });
});

describe('el resumen y lo que despues pasa de verdad', () => {
  /**
   * El "SI" del tesorero solo significa algo si aplicar hace exactamente lo
   * que el resumen mostro. Si fueran dos recorridos distintos, tarde o
   * temprano dirian cosas distintas.
   */
  it('coincide con lo que hace aplicarlo', async () => {
    const pagos = [
      pago(),
      pago({ id: 'pay-2', sourceMessageId: 'msg-2', fileHash: 'h2', reference: '999999999', house: '19' }),
      pago({ id: 'pay-3', sourceMessageId: 'msg-3', fileHash: 'h3', reference: '412000003', house: '20', amount: 175 }),
    ];
    const depositos = [deposito(), deposito({ id: 'mov-3', reference: '412000003', amount: 175 })];
    const resumen = resumirConciliacion(planReconciliation(pagos, depositos), depositos);

    const aplicado = await reconcilePendingPayments(new MemoryPaymentStore({ payments: pagos }), depositos, 'extracto-bac');

    expect(aplicado.verified).toBe(resumen.verificaria);
    expect(aplicado.notFound).toBe(resumen.sinDeposito);
    expect(aplicado.review).toBe(resumen.aRevision);
  });
});

describe('el mensaje al tesorero', () => {
  const resumen = {
    depositos: 3, depositosCentavos: 60000,
    verificaria: 2, verificariaCentavos: 30000,
    sinComprobante: 1, sinComprobanteCentavos: 30000,
    sinDeposito: 1, aRevision: 0,
  };

  it('dice las cuatro cifras y como confirmar', () => {
    const texto = textoDelResumen(resumen, '5:30 PM');

    expect(texto).toContain('Se verificarían: 2 pagos (L300.00)');
    expect(texto).toContain('Sin comprobante: 1 depósito (L300.00)');
    expect(texto).toContain('Sin depósito: 1 comprobante');
    expect(texto).toContain('A revisión: 0 pagos');
    expect(texto).toContain('SI');
    expect(texto).toContain('5:30 PM');
  });

  it('concuerda el singular y el plural', () => {
    const texto = textoDelResumen({ ...resumen, verificaria: 1 }, '5:30 PM');
    expect(texto).toContain('Se verificarían: 1 pago (');
  });

  /**
   * El mensaje se guarda en `resumen_json` y viaja por WhatsApp. Con contar
   * alcanza para decidir; nombres, viviendas y referencias no tienen por que
   * estar ahi (invariante 12).
   */
  it('no nombra a nadie ni a ninguna casa', () => {
    const texto = textoDelResumen(resumen, '5:30 PM');

    expect(texto).not.toMatch(/E\d+B\d+C\d+/);
    expect(texto).not.toMatch(/\d{9}/);
    expect(texto).not.toMatch(/\+504/);
  });
});
