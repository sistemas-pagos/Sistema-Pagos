import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { SYNTHETIC_BAC_RECEIPTS } from '@/src/demo/data';
import type { HomeRecord } from '@/src/domain/types';
import { processHomeReply, processReceiptMessage } from '@/src/services/payment-processor';
import { MemoryPaymentStore } from '@/src/storage/memory';

/**
 * Lo que pasa cuando el comprobante no alcanza para registrar el pago solo.
 *
 * De dieciseis comprobantes reales, nueve no dicen de que casa son y uno la
 * trae escrita a mano. Preguntar por WhatsApp no es el caso raro: es el camino
 * que va a recorrer mas de la mitad de los pagos, todos los meses.
 */
const homes: HomeRecord[] = [
  { id: 'home-e1-b4-c18', stage: '1', block: '4', house: '18', monthlyFee: 150, active: true },
];

const TELEFONO = '+50400000999';
const now = () => new Date('2026-09-08T18:00:00.000Z');

function png(variante: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, variante]);
}

/** Un comprobante correcto al que solo le falta decir la vivienda. */
const SIN_VIVIENDA = SYNTHETIC_BAC_RECEIPTS.missingHome;

beforeEach(() => {
  process.env.APP_MODE = 'demo';
  resetEnvForTests();
});

afterEach(() => {
  delete process.env.APP_MODE;
  resetEnvForTests();
});

async function comprobanteSinVivienda(store: MemoryPaymentStore, messageId = 'msg-1') {
  return processReceiptMessage({
    messageId, phone: TELEFONO, bytes: png(1), declaredMime: 'image/png', syntheticOcrText: SIN_VIVIENDA,
  }, { store, now });
}

describe('cuando el comprobante no dice la vivienda', () => {
  it('pregunta y deja el pago esperando respuesta', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const resultado = await comprobanteSinVivienda(store);

    expect(resultado.status).toBe('ESPERANDO_RESPUESTA');
    expect(resultado.reply).toContain('E1 B4 C18');
    const contexto = await store.getPendingByPhone(TELEFONO);
    expect(contexto?.attempts).toBe(0);
  });

  it('acepta la vivienda escrita como la escriben los vecinos', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);

    const resultado = await processHomeReply('msg-2', TELEFONO, 'etapa 1, bloque 4, casa 18', { store, now });

    expect(resultado.status).toBe('PENDIENTE_VERIFICACION');
    const pago = (await store.listPayments())[0];
    expect([pago.stage, pago.block, pago.house]).toEqual(['1', '4', '18']);
  });
});

describe('limite de intentos', () => {
  /**
   * Sin limite, quien no sabe su etapa recibe la misma pregunta para siempre y
   * el pago nunca avanza, aunque el dinero ya este en el banco.
   */
  it('a la tercera respuesta que no sirve, lo pasa a una persona', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);

    const primera = await processHomeReply('r1', TELEFONO, 'no sé', { store, now });
    const segunda = await processHomeReply('r2', TELEFONO, 'la de la esquina', { store, now });
    const tercera = await processHomeReply('r3', TELEFONO, 'ahí nomás', { store, now });

    expect(primera.reason).toBe('invalid_home_reply');
    expect(segunda.reason).toBe('invalid_home_reply');
    expect(tercera.reason).toBe('home_reply_attempts_exhausted');
    expect(tercera.status).toBe('EN_REVISION');

    const pago = (await store.listPayments())[0];
    expect(pago.status).toBe('EN_REVISION');
    expect(pago.reviewReason).toBe('home_reply_attempts_exhausted');
  });

  it('cierra el contexto al rendirse, para no seguir preguntando', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);

    for (const id of ['r1', 'r2', 'r3']) {
      await processHomeReply(id, TELEFONO, 'no sé', { store, now });
    }

    expect(await store.getPendingByPhone(TELEFONO)).toBeUndefined();
  });

  it('le dice al vecino que no vuelva a enviar el comprobante', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);

    for (const id of ['r1', 'r2']) await processHomeReply(id, TELEFONO, 'no sé', { store, now });
    const final = await processHomeReply('r3', TELEFONO, 'no sé', { store, now });

    expect(final.reply).toContain('una persona');
    expect(final.reply).toContain('no hace falta que lo envíes de nuevo');
  });

  /** Una vivienda que no esta en el padron tambien gasta intentos. */
  it('cuenta igual las viviendas que no existen', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);

    const primera = await processHomeReply('r1', TELEFONO, 'E9 B9 C9', { store, now });
    expect(primera.reason).toBe('home_not_found');
    expect((await store.getPendingByPhone(TELEFONO))?.attempts).toBe(1);
  });

  /** Acertar antes del limite no deja rastro de los intentos fallidos. */
  it('una respuesta buena despues de una mala registra el pago igual', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);

    await processHomeReply('r1', TELEFONO, 'no sé', { store, now });
    const buena = await processHomeReply('r2', TELEFONO, 'E1 B4 C18', { store, now });

    expect(buena.status).toBe('PENDIENTE_VERIFICACION');
    expect(await store.getPendingByPhone(TELEFONO)).toBeUndefined();
  });
});

describe('cuando la foto no se puede leer', () => {
  /**
   * Las imagenes no se guardan (invariante 11), asi que mandar una foto
   * ilegible a revision humana no sirve: quien la revise tampoco podra verla.
   * Se pide otra en el momento, mientras el vecino tiene el comprobante.
   */
  it('pide otra foto en vez de registrar el pago', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const resultado = await processReceiptMessage({
      messageId: 'borrosa', phone: TELEFONO, bytes: png(2), declaredMime: 'image/png',
    }, {
      store,
      now,
      ocr: async () => ({ text: 'BAC Notificacion de transferencia ...', confidence: 0.2 }),
    });

    expect(resultado.reason).toBe('ocr_low_confidence');
    expect(resultado.paymentId).toBeUndefined();
    expect(await store.listPayments()).toEqual([]);
  });

  it('avisa que no quedo registrado nada', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const resultado = await processReceiptMessage({
      messageId: 'borrosa', phone: TELEFONO, bytes: png(2), declaredMime: 'image/png',
    }, { store, now, ocr: async () => ({ text: 'algo', confidence: 0.1 }) });

    expect(resultado.reply).toContain('No quedó registrado ningún pago');
    expect(resultado.reply).toMatch(/de cerca|monto/);
  });

  /**
   * Una foto legible que no es un comprobante es otro problema, y pedir que la
   * tomen mejor no lo resuelve.
   */
  it('distingue una foto ilegible de algo que no es un comprobante', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const resultado = await processReceiptMessage({
      messageId: 'gato', phone: TELEFONO, bytes: png(3), declaredMime: 'image/png',
      syntheticOcrText: 'Lista del supermercado: leche, pan, huevos',
    }, { store, now });

    expect(resultado.reason).toBe('unsupported_receipt');
    expect(resultado.reply).toContain('No reconocimos un comprobante');
  });

  it('una foto nitida sigue registrando el pago', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    const resultado = await processReceiptMessage({
      messageId: 'nitida', phone: TELEFONO, bytes: png(4), declaredMime: 'image/png',
      syntheticOcrText: SYNTHETIC_BAC_RECEIPTS.valid,
    }, { store, now });

    expect(resultado.status).toBe('PENDIENTE_VERIFICACION');
    expect(await store.listPayments()).toHaveLength(1);
  });
});

describe('cuando el vecino contesta tarde', () => {
  /**
   * El contexto vence a los 30 minutos, pero el pago sigue sin vivienda mucho
   * despues. Antes, el vecino que contestaba a las dos horas —con la casa
   * correcta— recibia instrucciones genericas y su respuesta se tiraba.
   *
   * Vencer el contexto significa dejar de preguntar, no dejar de escuchar.
   */
  const dosHorasDespues = () => new Date('2026-09-08T20:00:00.000Z');

  it('toma la respuesta aunque el contexto ya haya vencido', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);
    await store.clearPending(TELEFONO);

    const resultado = await processHomeReply('tarde', TELEFONO, 'E1 B4 C18', { store, now: dosHorasDespues });

    expect(resultado.status).toBe('PENDIENTE_VERIFICACION');
    const pago = (await store.listPayments())[0];
    expect([pago.stage, pago.block, pago.house]).toEqual(['1', '4', '18']);
  });

  /** Aunque el barrido diario ya lo haya mandado a revision por no contestar. */
  it('rescata un pago que el barrido ya habia mandado a revision', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);
    await store.clearPending(TELEFONO);
    const pago = (await store.listPayments())[0];
    await store.updatePayment({ ...pago, status: 'EN_REVISION', reviewReason: 'home_reply_timeout' });

    const resultado = await processHomeReply('tarde', TELEFONO, 'E1 B4 C18', { store, now: dosHorasDespues });

    expect(resultado.status).toBe('PENDIENTE_VERIFICACION');
    expect((await store.listPayments())[0].reviewReason).toBeUndefined();
  });

  /**
   * Decir de que casa es no arregla un monto que no cuadra. Se guarda la
   * vivienda, que es informacion util, y el pago sigue esperando a una persona.
   */
  it('llena la vivienda pero no saca de revision un pago con otro problema', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);
    await store.clearPending(TELEFONO);
    const pago = (await store.listPayments())[0];
    await store.updatePayment({ ...pago, status: 'EN_REVISION', reviewReason: 'amount_above_expected' });

    const resultado = await processHomeReply('tarde', TELEFONO, 'E1 B4 C18', { store, now: dosHorasDespues });

    expect(resultado.status).toBe('EN_REVISION');
    const actualizado = (await store.listPayments())[0];
    expect(actualizado.stage).toBe('1');
    expect(actualizado.reviewReason).toBe('amount_above_expected');
  });

  /** Un pago ya verificado no se toca: ese vecino no esta contestando nada. */
  it('no toca un pago que ya tiene vivienda', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);
    await processHomeReply('r1', TELEFONO, 'E1 B4 C18', { store, now });

    const resultado = await processHomeReply('tarde', TELEFONO, 'E1 B4 C18', { store, now: dosHorasDespues });

    expect(resultado.action).toBe('silent');
    expect(resultado.reason).toBe('no_pending_receipt');
  });

  /** Sin contexto no hay intentos que gastar: se responde y se deja como esta. */
  it('no gasta intentos con una respuesta tardia que no se entiende', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store);
    await store.clearPending(TELEFONO);

    const resultado = await processHomeReply('tarde', TELEFONO, 'no sé', { store, now: dosHorasDespues });

    expect(resultado.reason).toBe('invalid_home_reply');
    expect((await store.listPayments())[0].status).toBe('ESPERANDO_RESPUESTA');
  });

  /** Si tiene dos sin vivienda, la respuesta va al mas reciente. */
  it('aplica la respuesta al ultimo comprobante que mando', async () => {
    const store = new MemoryPaymentStore({ homes }, now);
    await comprobanteSinVivienda(store, 'msg-viejo');
    await store.clearPending(TELEFONO);
    await processReceiptMessage({
      messageId: 'msg-nuevo', phone: TELEFONO, bytes: png(9), declaredMime: 'image/png', syntheticOcrText: SIN_VIVIENDA,
    }, { store, now: dosHorasDespues });
    await store.clearPending(TELEFONO);

    await processHomeReply('tarde', TELEFONO, 'E1 B4 C18', { store, now: dosHorasDespues });

    const pagos = await store.listPayments();
    const nuevo = pagos.find((pago) => pago.sourceMessageId === 'msg-nuevo');
    const viejo = pagos.find((pago) => pago.sourceMessageId === 'msg-viejo');
    expect(nuevo?.stage).toBe('1');
    expect(viejo?.stage).toBeUndefined();
  });
});
