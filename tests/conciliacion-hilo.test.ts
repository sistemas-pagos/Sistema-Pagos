import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractoBac } from './fixtures/extracto-bac';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import { resetEnvForTests } from '@/src/config/env';
import type { PaymentRecord } from '@/src/domain/types';
import { aplicarConfirmacion, cancelarConfirmacion, recibirExtracto } from '@/src/services/conciliacion';
import { MemoryPaymentStore } from '@/src/storage/memory';
import type { Usuario } from '@/src/storage/usuarios';

/**
 * El hilo entero: llega el extracto, el tesorero lee el resumen, responde SI y
 * recien ahi se verifican los pagos y salen los recibos.
 *
 * Lo que se prueba no es que hable con WhatsApp, sino que **lo que se aplica
 * sea exactamente lo que se mostro**, y que un "SI" repetido no aplique dos
 * veces.
 */
const TESORERO: Usuario = { id: 'u1', nombre: 'Tesorero', rol: 'TESORERO', activo: true };
const AHORA = new Date('2026-09-16T12:00:00.000Z');
const DESPUES_DE_VENCER = new Date('2026-09-16T20:00:00.000Z');

let db: Client;
let store: MemoryPaymentStore;

function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
    sourceMessageId: 'msg-1', phone: '50400000001', bank: 'BAC Honduras', amount: 150,
    transactionDate: '2026-09-02', reference: '412000001', stage: '1', block: '4', house: '18',
    period: '2026-09', status: 'PENDIENTE_VERIFICACION', fileHash: 'sha-1', ...overrides,
  };
}

beforeEach(async () => {
  process.env.APP_MODE = 'demo';
  process.env.EXPECTED_ACCOUNT_LAST4 = '2233';
  resetEnvForTests();
  db = await nuevaBaseDePrueba();
  await db.execute("INSERT INTO usuarios (id, nombre, rol) VALUES ('u1', 'Tesorero', 'TESORERO')");
  store = new MemoryPaymentStore({ payments: [pago()] });
});

afterEach(() => {
  db.close();
  delete process.env.APP_MODE;
  delete process.env.EXPECTED_ACCOUNT_LAST4;
  resetEnvForTests();
});

const deps = () => ({ db, store, ahora: () => AHORA });

describe('llega el extracto', () => {
  it('devuelve el resumen y todavia no verifica nada', async () => {
    const resultado = await recibirExtracto(deps(), TESORERO, extractoBac());

    expect(resultado).toMatchObject({ tipo: 'respuesta' });
    if (resultado.tipo !== 'respuesta') throw new Error('sin respuesta');
    expect(resultado.respuesta).toContain('Se verificarían: 1 pago');
    expect(resultado.respuesta).toContain('SI');
    expect((await store.getPayment('pay-1'))?.status).toBe('PENDIENTE_VERIFICACION');
  });

  /**
   * Un extracto de otra cuenta verificaria pagos contra depositos que nunca
   * entraron a la cuenta de cobro (invariante 4).
   */
  it('rechaza el extracto de otra cuenta', async () => {
    const resultado = await recibirExtracto(deps(), TESORERO, extractoBac({ cuenta: '745374361' }));

    if (resultado.tipo !== 'respuesta') throw new Error('sin respuesta');
    expect(resultado.respuesta).toContain('no es de la cuenta de cobro');
  });

  /** El tesorero tambien es vecino: su comprobante sigue por el otro camino. */
  it('un archivo que no es un extracto no se trata como tal', async () => {
    const resultado = await recibirExtracto(deps(), TESORERO, Buffer.from('cualquier cosa', 'utf8'));

    expect(resultado.tipo).toBe('no_es_extracto');
  });

  /** Que no cuadre si es asunto suyo: el archivo era del banco. */
  it('avisa cuando los saldos no suman', async () => {
    const roto = extractoBac({ movimientos: [{
      fecha: '02/09/2026', referencia: '412000001', codigo: 'TF',
      descripcion: 'TEF DE:PRUEBA', debito: '0.00', credito: '150.00', balance: '9999.00',
    }] });

    const resultado = await recibirExtracto(deps(), TESORERO, roto);

    if (resultado.tipo !== 'respuesta') throw new Error('sin respuesta');
    expect(resultado.respuesta).toContain('no cuadra');
  });

  it('no deja mandar el mismo archivo dos veces', async () => {
    await recibirExtracto(deps(), TESORERO, extractoBac());

    const segunda = await recibirExtracto(deps(), TESORERO, extractoBac());

    if (segunda.tipo !== 'respuesta') throw new Error('sin respuesta');
    expect(segunda.respuesta).toContain('ya lo habías mandado');
  });
});

describe('el SI aplica', () => {
  beforeEach(async () => { await recibirExtracto(deps(), TESORERO, extractoBac()); });

  it('verifica el pago y emite su recibo', async () => {
    const respuesta = await aplicarConfirmacion(deps(), TESORERO);

    expect(respuesta).toContain('1 pago(s) verificado(s)');
    expect(respuesta).toContain('1 recibo(s)');
    expect((await store.getPayment('pay-1'))?.status).toBe('VERIFICADO');
    expect(store.receiptFor('pay-1')).toBeDefined();
  });

  /**
   * Dos "SI" seguidos llegan como dos corridas del worker. Si aplicaran las
   * dos, saldrian dos recibos con numeros distintos para el mismo pago.
   */
  it('un segundo SI no aplica de nuevo', async () => {
    await aplicarConfirmacion(deps(), TESORERO);

    const segunda = await aplicarConfirmacion(deps(), TESORERO);

    expect(segunda).toContain('No hay ningún extracto esperando');
  });

  it('el NO lo descarta sin tocar nada', async () => {
    const respuesta = await cancelarConfirmacion(deps(), TESORERO);

    expect(respuesta).toContain('No se aplicó nada');
    expect((await store.getPayment('pay-1'))?.status).toBe('PENDIENTE_VERIFICACION');
  });

  /** Un extracto de hace horas se aplicaria contra pagos que ya cambiaron. */
  it('una confirmacion vencida no aplica', async () => {
    const respuesta = await aplicarConfirmacion({ db, store, ahora: () => DESPUES_DE_VENCER }, TESORERO);

    expect(respuesta).toContain('No hay ningún extracto esperando');
    expect((await store.getPayment('pay-1'))?.status).toBe('PENDIENTE_VERIFICACION');
  });

  it('nadie confirma lo que subio otro', async () => {
    await db.execute("INSERT INTO usuarios (id, nombre, rol) VALUES ('u2', 'Otro', 'ADMIN')");

    const respuesta = await aplicarConfirmacion(deps(), { id: 'u2', nombre: 'Otro', rol: 'ADMIN', activo: true });

    expect(respuesta).toContain('No hay ningún extracto esperando');
  });
});

describe('lo que se muestra es lo que se aplica', () => {
  /**
   * El "SI" del tesorero solo significa algo si aplicar hace exactamente lo que
   * el resumen dijo. Son dos momentos distintos y dos lecturas distintas de la
   * base: si no coincidieran, lo confirmado no seria lo que pasa.
   */
  it('el resumen y el resultado dicen el mismo numero', async () => {
    const resultado = await recibirExtracto(deps(), TESORERO, extractoBac());
    if (resultado.tipo !== 'respuesta') throw new Error('sin respuesta');
    const prometidos = /Se verificarían: (\d+) pago/.exec(resultado.respuesta)?.[1];

    const aplicado = await aplicarConfirmacion(deps(), TESORERO);

    expect(aplicado).toContain(`${prometidos} pago(s) verificado(s)`);
  });
});
