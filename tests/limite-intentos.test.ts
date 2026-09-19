import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import {
  BLOQUEO_MINUTOS, MAX_INTENTOS, estadoDelOrigen, expirarIntentos, huellaDeOrigen,
  limpiarIntentos, origenDeLaPeticion, registrarFallo,
} from '@/src/auth/intentos';
import { resetEnvForTests } from '@/src/config/env';

/**
 * El limite de intentos de acceso al panel (docs/PLAN.md, fase 7).
 *
 * El panel se abre con una sola clave compartida. Sin limite esa clave vale lo
 * que tarde en adivinarse; con limite, adivinarla deja de ser una opcion. Lo
 * que estas pruebas cuidan ademas es que el bloqueo **caduque solo**: un limite
 * que no se suelta es una forma de dejar al tesorero afuera.
 */
let db: Client;

const ORIGEN = '203.0.113.7';
const ACTOR = 'panel:login';
const T0 = new Date('2026-09-18T12:00:00.000Z');

function mas(minutos: number, desde = T0): Date {
  return new Date(desde.getTime() + minutos * 60_000);
}

async function fallar(veces: number, ahora = T0): Promise<boolean> {
  let bloqueo = false;
  for (let i = 0; i < veces; i += 1) {
    bloqueo = await registrarFallo(db, huellaDeOrigen(ORIGEN), ahora, ACTOR);
  }
  return bloqueo;
}

beforeEach(async () => {
  process.env.APP_MODE = 'production';
  process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-that-is-not-production';
  process.env.ADMIN_ACCESS_KEY = 'synthetic-admin-key-that-is-not-production';
  process.env.PAGOS_TURSO_URL = ':memory:';
  resetEnvForTests();
  db = await nuevaBaseDePrueba();
});

afterEach(() => {
  db.close();
  delete process.env.APP_MODE;
  delete process.env.AUTH_SESSION_SECRET;
  delete process.env.ADMIN_ACCESS_KEY;
  delete process.env.PAGOS_TURSO_URL;
  resetEnvForTests();
});

describe('la huella del origen', () => {
  /**
   * Una IP es un dato personal y este repositorio es publico (invariante 12).
   * Lo que se guarda no puede ser la direccion.
   */
  it('no deja la direccion en la base', async () => {
    await fallar(1);

    const { rows } = await db.execute('SELECT huella FROM intentos_login');
    expect(String(rows[0].huella)).not.toContain(ORIGEN);
    expect(String(rows[0].huella)).not.toContain('203.0');
  });

  /**
   * HMAC y no un hash a secas: el espacio IPv4 tiene cuatro mil millones de
   * valores y una tabla lo invierte entero. Si cambia el secreto, la huella
   * cambia — que es lo que hace que sin el secreto no diga de quien es.
   */
  it('depende del secreto de sesion', () => {
    const conUnSecreto = huellaDeOrigen(ORIGEN);

    process.env.AUTH_SESSION_SECRET = 'otro-secreto-sintetico-distinto-del-anterior';
    resetEnvForTests();

    expect(huellaDeOrigen(ORIGEN)).not.toBe(conUnSecreto);
  });

  it('separa origenes distintos', () => {
    expect(huellaDeOrigen('203.0.113.7')).not.toBe(huellaDeOrigen('203.0.113.8'));
  });

  /** Detras del proxy de Vercel la direccion real es la primera de la lista. */
  it('lee el primer valor de x-forwarded-for', () => {
    const peticion = new Request('https://ejemplo.test/api/admin/login', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' },
    });

    expect(origenDeLaPeticion(peticion)).toBe('203.0.113.7');
  });

  /** Sin encabezado, todos esos intentos comparten cuenta: mejor eso que no contarlos. */
  it('cuenta igual los intentos sin origen conocido', () => {
    expect(origenDeLaPeticion(new Request('https://ejemplo.test/api/admin/login'))).toBe('sin-origen');
  });
});

describe('el bloqueo', () => {
  it('deja pasar los primeros intentos y corta en el limite', async () => {
    expect(await fallar(MAX_INTENTOS - 1)).toBe(false);
    expect((await estadoDelOrigen(db, huellaDeOrigen(ORIGEN), T0)).bloqueado).toBe(false);

    expect(await fallar(1)).toBe(true);
    expect((await estadoDelOrigen(db, huellaDeOrigen(ORIGEN), T0)).bloqueado).toBe(true);
  });

  it('dice cuantos minutos faltan', async () => {
    await fallar(MAX_INTENTOS);

    const estado = await estadoDelOrigen(db, huellaDeOrigen(ORIGEN), mas(5));
    expect(estado).toEqual({ bloqueado: true, minutosRestantes: BLOQUEO_MINUTOS - 5 });
  });

  /** Un bloqueo que no caduca deja al tesorero afuera para siempre. */
  it('se suelta solo al pasar la espera', async () => {
    await fallar(MAX_INTENTOS);

    expect((await estadoDelOrigen(db, huellaDeOrigen(ORIGEN), mas(BLOQUEO_MINUTOS + 1))).bloqueado).toBe(false);
  });

  /**
   * La cuenta se reinicia sola. Si no, cinco errores repartidos en un año
   * bloquearian a quien nada mas tiene mala memoria.
   */
  it('no suma fallos viejos con fallos nuevos', async () => {
    await fallar(MAX_INTENTOS - 1);

    expect(await fallar(1, mas(BLOQUEO_MINUTOS + 1))).toBe(false);
    expect((await estadoDelOrigen(db, huellaDeOrigen(ORIGEN), mas(BLOQUEO_MINUTOS + 1))).bloqueado).toBe(false);
  });

  it('bloquea un origen sin bloquear a los demas', async () => {
    await fallar(MAX_INTENTOS);

    expect((await estadoDelOrigen(db, huellaDeOrigen('198.51.100.2'), T0)).bloqueado).toBe(false);
  });

  it('entrar bien borra la cuenta de fallos', async () => {
    await fallar(MAX_INTENTOS - 1);
    await limpiarIntentos(db, huellaDeOrigen(ORIGEN));

    expect(await fallar(MAX_INTENTOS - 1)).toBe(false);
  });
});

describe('el rastro que deja', () => {
  /**
   * Un evento por intento seria una forma de llenar `eventos` desde afuera, y
   * `eventos` no se puede borrar (invariante 8). Solo el bloqueo deja rastro.
   */
  it('escribe un evento al bloquear, no uno por intento', async () => {
    await fallar(MAX_INTENTOS);

    const { rows } = await db.execute("SELECT accion, motivo, actor, entidad_id FROM eventos WHERE entidad = 'intentos_login'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accion: 'BLOQUEAR', motivo: 'max_intentos_login', actor: ACTOR });
    expect(String(rows[0].entidad_id)).not.toContain(ORIGEN);
  });

  it('no escribe otro evento mientras el bloqueo sigue vigente', async () => {
    await fallar(MAX_INTENTOS);
    await fallar(3, mas(1));

    const { rows } = await db.execute("SELECT count(*) AS c FROM eventos WHERE entidad = 'intentos_login'");
    expect(Number(rows[0].c)).toBe(1);
  });
});

describe('el barrido de mantenimiento', () => {
  it('borra lo que ya no bloquea a nadie y deja lo vigente', async () => {
    await fallar(MAX_INTENTOS);
    await registrarFallo(db, huellaDeOrigen('198.51.100.2'), mas(BLOQUEO_MINUTOS + 5), ACTOR);

    expect(await expirarIntentos(db, mas(BLOQUEO_MINUTOS + 5))).toBe(1);

    const { rows } = await db.execute('SELECT count(*) AS c FROM intentos_login');
    expect(Number(rows[0].c)).toBe(1);
  });
});
