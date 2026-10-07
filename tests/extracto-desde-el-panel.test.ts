import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractoBac } from './fixtures/extracto-bac';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import { resetEnvForTests } from '@/src/config/env';
import type { PaymentRecord } from '@/src/domain/types';
import {
  aplicarConfirmacion,
  confirmarExtracto,
  descartarExtracto,
  recibirExtracto,
} from '@/src/services/conciliacion';
import { MemoryPaymentStore } from '@/src/storage/memory';
import type { Usuario } from '@/src/storage/usuarios';

/**
 * El extracto cargado desde el panel.
 *
 * La pantalla no decide nada: llama a las mismas funciones que el worker de
 * WhatsApp. Lo que estas pruebas cuidan es la costura entre las dos
 * superficies — que el resultado viaje como **dato** y no como castellano, y
 * que cada codigo que el servicio puede devolver tenga algo escrito en la
 * pantalla. Un codigo sin texto no falla: deja un hueco en blanco arriba de un
 * boton que verifica pagos.
 */
const TESORERO: Usuario = { id: 'u1', nombre: 'Tesorero', rol: 'TESORERO', activo: true };
const AHORA = new Date('2026-09-16T12:00:00.000Z');

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

describe('el resultado viaja como dato', () => {
  it('cada final de la lectura trae su codigo', async () => {
    const bueno = await recibirExtracto(deps(), TESORERO, extractoBac());
    expect(bueno).toMatchObject({ tipo: 'respuesta', motivo: 'resumen' });

    const repetido = await recibirExtracto(deps(), TESORERO, extractoBac());
    expect(repetido).toMatchObject({ tipo: 'respuesta', motivo: 'ya_estaba' });

    const ajena = await recibirExtracto(deps(), TESORERO, extractoBac({ cuenta: '745374361' }));
    expect(ajena).toMatchObject({ tipo: 'respuesta', motivo: 'otra_cuenta' });

    const roto = extractoBac({ movimientos: [{
      fecha: '02/09/2026', referencia: '412000001', codigo: 'TF',
      descripcion: 'TEF DE:PRUEBA', debito: '0.00', credito: '150.00', balance: '9999.00',
    }] });
    expect(await recibirExtracto(deps(), TESORERO, roto)).toMatchObject({ tipo: 'respuesta', motivo: 'no_cuadra' });
  });

  it('confirmar devuelve los numeros, no una frase', async () => {
    await recibirExtracto(deps(), TESORERO, extractoBac());

    const resultado = await confirmarExtracto(deps(), TESORERO);

    expect(resultado).toEqual({ tipo: 'aplicada', verificados: 1, recibos: 1, sinRespaldo: 0, aRevision: 0 });
    expect((await store.getPayment('pay-1'))?.status).toBe('VERIFICADO');
  });

  it('descartar y el vacio tambien son codigos', async () => {
    expect(await descartarExtracto(deps(), TESORERO)).toEqual({ tipo: 'nada_esperando' });

    await recibirExtracto(deps(), TESORERO, extractoBac());

    expect(await descartarExtracto(deps(), TESORERO)).toEqual({ tipo: 'cancelada' });
    expect((await store.getPayment('pay-1'))?.status).toBe('PENDIENTE_VERIFICACION');
  });

  /**
   * El camino de WhatsApp quedo envuelto sobre el nuevo. Si el texto cambiara,
   * el tesorero que sigue usando el «SI» leeria otra cosa que la de siempre.
   */
  it('WhatsApp sigue recibiendo el mismo texto', async () => {
    await recibirExtracto(deps(), TESORERO, extractoBac());

    const texto = await aplicarConfirmacion(deps(), TESORERO);

    expect(texto).toContain('1 pago(s) verificado(s)');
    expect(texto).toContain('1 recibo(s) emitido(s)');
  });
});

/*
 * Lo de abajo se lee como texto a proposito: lo que puede faltar es una clave
 * del diccionario o el nombre de un campo del formulario, y no hay nada que
 * invocar cuando el problema es una cadena que no esta.
 */
const pagina = readFileSync(new URL('../app/admin/extracto/page.tsx', import.meta.url), 'utf8');
const ruta = readFileSync(new URL('../app/api/admin/extracto/route.ts', import.meta.url), 'utf8');

describe('la pantalla sabe decir todo lo que puede pasar', () => {
  /** Los cuatro de la lectura, los tres de la confirmacion y los dos del archivo. */
  const CODIGOS = [
    'resumen', 'ya_estaba', 'otra_cuenta', 'no_cuadra', 'no_es_extracto',
    'cancelada', 'nada_esperando', 'ya_no_vale',
    'sin_archivo', 'demasiado_grande',
  ];

  it.each(CODIGOS.filter((codigo) => codigo !== 'resumen'))('tiene texto para %s', (codigo) => {
    expect(pagina).toContain(`${codigo}:`);
  });

  /**
   * `resumen` es el unico que no lleva frase: cuando quedo algo esperando, la
   * pantalla muestra el resumen con sus numeros y sus dos botones.
   */
  it('al resumen le corresponden los numeros, no una frase', () => {
    expect(pagina).not.toContain('resumen:');
    expect(pagina).toContain('importacionPendienteDe');
    expect(pagina).toContain('Se verificarían');
  });

  it('los botones mandan las acciones que la ruta atiende', () => {
    expect(pagina).toContain('value="confirmar"');
    expect(pagina).toContain('value="descartar"');
    expect(ruta).toContain("accion === 'confirmar'");
    expect(ruta).toContain("accion === 'descartar'");
  });

  /** El nombre del campo es la unica union entre el formulario y la ruta. */
  it('el archivo entra por el campo que la ruta lee', () => {
    expect(pagina).toContain('name="archivo"');
    expect(pagina).toContain('encType="multipart/form-data"');
    expect(ruta).toContain("form.get('archivo')");
  });

  /**
   * Un recibo emitido y nadie que lo mande.
   *
   * `enviar-recibos` arranca por `repository_dispatch`, al terminar
   * `procesar-comprobantes`, o por cron. Desde el panel no corre ningun
   * workflow: sin el aviso explicito el recibo espera al cron, que en este
   * repositorio promedia casi cinco horas, mientras la pantalla ya dice
   * «aplicado». Lo mismo vale para cualquier ruta que emita recibos.
   */
  it.each([
    ['el extracto', 'app/api/admin/extracto/route.ts'],
    ['el cobro en efectivo', 'app/api/cobros/[vivienda]/route.ts'],
  ])('%s pide el envio en el momento', (_nombre, archivo) => {
    const fuente = readFileSync(new URL(`../${archivo}`, import.meta.url), 'utf8');

    expect(fuente).toContain('requestReceiptSending');
  });

  /** Verificar pagos no puede quedar detras de una sesion con el rol viejo. */
  it('la ruta vuelve a leer el rol de la base', () => {
    expect(ruta).toContain('usuarioPorId');
    expect(ruta).toContain('puedeConciliar');
    expect(ruta).toContain('isSameOriginRequest');
  });
});
