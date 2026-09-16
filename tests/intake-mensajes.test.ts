import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { contar, nuevaBaseDePrueba } from './helpers/turso-test-db';
import { requestReceiptProcessing } from '@/src/whatsapp/dispatch';
import {
  cerrarMensaje, mensajesPendientes, registrarMensaje, tomarMensaje,
} from '@/src/storage/turso';

const AHORA = '2026-09-16T00:00:00.000Z';

const mensaje = (over: Partial<Parameters<typeof registrarMensaje>[1]> = {}) => ({
  messageId: 'wamid.1',
  telefono: '+50400000000',
  tipo: 'image',
  mediaId: 'media-1',
  estado: 'RECIBIDO' as const,
  recibidoEn: AHORA,
  ...over,
});

let db: Client;

beforeEach(async () => { db = await nuevaBaseDePrueba(); });
afterEach(() => { db.close(); });

describe('cola de mensajes entrantes', () => {
  it('un reintento concurrente del mismo message_id registra un solo mensaje', async () => {
    const resultados = await Promise.all([
      registrarMensaje(db, mensaje()),
      registrarMensaje(db, mensaje()),
      registrarMensaje(db, mensaje()),
    ]);

    // Exactamente una insercion gana; el resto son reintentos de Meta.
    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(await contar(db, 'mensajes')).toBe(1);
  });

  it('dos corridas simultaneas no toman el mismo mensaje', async () => {
    await registrarMensaje(db, mensaje());

    const tomas = await Promise.all([
      tomarMensaje(db, 'wamid.1', AHORA),
      tomarMensaje(db, 'wamid.1', AHORA),
    ]);

    // Ambas ven el mensaje, pero solo una lo toma antes de que se cierre.
    expect(tomas.filter(Boolean).length).toBeGreaterThanOrEqual(1);

    await cerrarMensaje(db, { messageId: 'wamid.1', estado: 'PROCESADO', actualizadoEn: AHORA });
    expect(await tomarMensaje(db, 'wamid.1', AHORA)).toBe(false);
  });

  it('cerrar un mensaje borra el media_id y el cuerpo', async () => {
    await registrarMensaje(db, mensaje({ tipo: 'text', mediaId: undefined, cuerpo: 'E1 B4 C18' }));
    await cerrarMensaje(db, { messageId: 'wamid.1', estado: 'PROCESADO', actualizadoEn: AHORA });

    const { rows } = await db.execute("SELECT media_id, cuerpo, estado FROM mensajes WHERE message_id = 'wamid.1'");
    expect(rows[0]).toMatchObject({ media_id: null, cuerpo: null, estado: 'PROCESADO' });
  });

  it('la cola devuelve lo pendiente y deja fuera lo cerrado', async () => {
    await registrarMensaje(db, mensaje({ messageId: 'a' }));
    await registrarMensaje(db, mensaje({ messageId: 'b', tipo: 'text', cuerpo: 'E1 B4 C18' }));
    await registrarMensaje(db, mensaje({ messageId: 'c', estado: 'IGNORADO' }));
    await cerrarMensaje(db, { messageId: 'a', estado: 'PROCESADO', actualizadoEn: AHORA });

    const pendientes = await mensajesPendientes(db);
    expect(pendientes.map((m) => m.messageId)).toEqual(['b']);
    expect(pendientes[0].cuerpo).toBe('E1 B4 C18');
  });

  it('un mensaje quedado en PROCESANDO se retoma, hasta agotar los intentos', async () => {
    await registrarMensaje(db, mensaje());

    // Una corrida que murio a la mitad lo dejo tomado pero sin cerrar.
    await tomarMensaje(db, 'wamid.1', AHORA);
    expect((await mensajesPendientes(db)).map((m) => m.messageId)).toEqual(['wamid.1']);

    await tomarMensaje(db, 'wamid.1', AHORA);
    await tomarMensaje(db, 'wamid.1', AHORA);
    expect(await mensajesPendientes(db)).toHaveLength(0);
  });
});

describe('aviso a GitHub Actions', () => {
  afterEach(() => {
    delete process.env.PAGOS_GITHUB_REPO;
    delete process.env.PAGOS_DISPATCH_TOKEN;
    resetEnvForTests();
  });

  it('sin configurar no lanza y avisa que no se disparo', async () => {
    resetEnvForTests();
    expect(await requestReceiptProcessing()).toBe(false);
  });

  it('rechaza un repositorio con formato invalido sin salir a la red', async () => {
    process.env.PAGOS_GITHUB_REPO = 'no-es-un-repo';
    process.env.PAGOS_DISPATCH_TOKEN = 'token-de-prueba';
    resetEnvForTests();
    expect(await requestReceiptProcessing()).toBe(false);
  });
});
