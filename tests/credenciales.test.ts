import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, nuevaBaseDePrueba } from './helpers/turso-test-db';
import { resetEnvForTests } from '@/src/config/env';
import { hashDeClave, verificarClave, LARGO_MINIMO_CLAVE } from '@/src/auth/claves';
import { credencialValida, claveCompartidaValida } from '@/src/auth/credenciales';
import { BLOQUEO_MINUTOS, MAX_INTENTOS } from '@/src/auth/intentos';
import { crearUsuario, credencialPorLogin, fijarCredenciales, normalizarLogin } from '@/src/storage/usuarios';

/**
 * Entrar con usuario propio y con rol.
 *
 * Lo que estas pruebas cuidan no es que la clave correcta abra —eso es lo
 * facil— sino que **todo lo que no abre se vea igual desde afuera**: usuario
 * inexistente, usuario de baja, usuario sin clave y clave mala tienen que dar
 * exactamente la misma respuesta. Cualquier diferencia le dice a quien prueba
 * claves si el usuario existe, que es la mitad del trabajo regalada.
 */
const EN = '2026-09-30T12:00:00.000Z';
const CLAVE = 'una-clave-larga-de-verdad';

let db: Client;

beforeEach(async () => {
  db = await nuevaBaseDePrueba();
  process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-that-is-not-production';
  resetEnvForTests();
});

afterEach(() => {
  db.close();
  delete process.env.ADMIN_ACCESS_KEY;
  delete process.env.AUTH_SESSION_SECRET;
  resetEnvForTests();
});

async function conCredencial(
  id: string,
  rol: 'ADMIN' | 'TESORERO' | 'COBRADOR',
  login: string,
  clave = CLAVE,
): Promise<void> {
  await crearUsuario(db, { id, nombre: id, rol }, ACTOR, EN);
  await fijarCredenciales(db, { id, login, claveHash: await hashDeClave(clave) }, ACTOR, EN);
}

describe('el hash de la clave', () => {
  it('la misma clave nunca da el mismo hash dos veces', async () => {
    const a = await hashDeClave(CLAVE);
    const b = await hashDeClave(CLAVE);

    expect(a).not.toBe(b);
    expect(await verificarClave(CLAVE, a)).toBe(true);
    expect(await verificarClave(CLAVE, b)).toBe(true);
  });

  it('la clave no aparece en lo que se guarda', async () => {
    const guardado = await hashDeClave(CLAVE);
    expect(guardado).not.toContain(CLAVE);
    expect(guardado.startsWith('scrypt:')).toBe(true);
  });

  it('una clave distinta no pasa, ni aunque se parezca', async () => {
    const guardado = await hashDeClave(CLAVE);
    expect(await verificarClave(`${CLAVE} `, guardado)).toBe(false);
    expect(await verificarClave(CLAVE.toUpperCase(), guardado)).toBe(false);
    expect(await verificarClave('', guardado)).toBe(false);
  });

  /** Un hash roto en la base no puede tumbar el login de todos. */
  it('un hash ausente o mal formado devuelve false en vez de reventar', async () => {
    expect(await verificarClave(CLAVE, undefined)).toBe(false);
    expect(await verificarClave(CLAVE, '')).toBe(false);
    expect(await verificarClave(CLAVE, 'cualquier-cosa')).toBe(false);
    expect(await verificarClave(CLAVE, 'scrypt:1:2:3')).toBe(false);
    expect(await verificarClave(CLAVE, 'sha256:32768:8:1:c2Fs:aGFzaA==')).toBe(false);
  });

  /** Un N absurdo guardado en la base colgaria el proceso si se obedeciera. */
  it('un coste fuera de rango se rechaza en vez de obedecerlo', async () => {
    expect(await verificarClave(CLAVE, 'scrypt:999999999:8:1:c2Fs:aGFzaA==')).toBe(false);
    expect(await verificarClave(CLAVE, 'scrypt:16:8:1:c2Fs:aGFzaA==')).toBe(false);
  });
});

describe('quien puede entrar', () => {
  it('el usuario correcto entra con su rol', async () => {
    await conCredencial('u-cobrador', 'COBRADOR', 'marvin');
    expect(await credencialValida(db, 'marvin', CLAVE)).toEqual({ uid: 'u-cobrador', rol: 'COBRADOR' });
  });

  it('el usuario no distingue mayusculas ni espacios al escribirlo', async () => {
    await conCredencial('u-admin', 'ADMIN', 'eduardo');

    expect(await credencialValida(db, 'Eduardo', CLAVE)).toEqual({ uid: 'u-admin', rol: 'ADMIN' });
    expect(await credencialValida(db, '  EDUARDO  ', CLAVE)).toEqual({ uid: 'u-admin', rol: 'ADMIN' });
    expect(normalizarLogin('  Marvin ')).toBe('marvin');
  });

  /** Las cuatro formas de no entrar dan lo mismo: `undefined`. */
  it('todo lo que no abre se ve igual desde afuera', async () => {
    await conCredencial('u-admin', 'ADMIN', 'eduardo');
    await crearUsuario(db, { id: 'u-sin-clave', nombre: 'sin clave', rol: 'COBRADOR' }, ACTOR, EN);
    await conCredencial('u-baja', 'COBRADOR', 'debaja');
    await db.execute("UPDATE usuarios SET activo = 0 WHERE id = 'u-baja'");

    expect(await credencialValida(db, 'noexiste', CLAVE)).toBeUndefined();
    expect(await credencialValida(db, 'eduardo', 'otra-clave')).toBeUndefined();
    expect(await credencialValida(db, 'u-sin-clave', CLAVE)).toBeUndefined();
    expect(await credencialValida(db, 'debaja', CLAVE)).toBeUndefined();
  });

  it('dar de baja a alguien le corta el acceso en el momento', async () => {
    await conCredencial('u-cobrador', 'COBRADOR', 'marvin');
    expect(await credencialValida(db, 'marvin', CLAVE)).toBeDefined();

    await db.execute("UPDATE usuarios SET activo = 0 WHERE id = 'u-cobrador'");
    expect(await credencialValida(db, 'marvin', CLAVE)).toBeUndefined();
  });

  it('dos personas no pueden tener el mismo usuario', async () => {
    await conCredencial('u-uno', 'COBRADOR', 'marvin');
    await crearUsuario(db, { id: 'u-dos', nombre: 'otro', rol: 'COBRADOR' }, ACTOR, EN);

    await expect(fijarCredenciales(
      db,
      { id: 'u-dos', login: 'marvin', claveHash: await hashDeClave(CLAVE) },
      ACTOR,
      EN,
    )).rejects.toThrow(/UNIQUE/i);
  });

  it('cambiar la credencial deja evento, sin decir cual es', async () => {
    await conCredencial('u-admin', 'ADMIN', 'eduardo');

    const { rows } = await db.execute(
      "SELECT accion, despues_json FROM eventos WHERE entidad = 'usuarios' AND accion = 'CREDENCIAL'",
    );
    expect(rows).toHaveLength(1);
    const despues = String(rows[0].despues_json);
    expect(despues).not.toContain(CLAVE);
    expect(despues).not.toContain('eduardo');
  });

  it('el hash guardado no viaja en la fila del usuario comun', async () => {
    await conCredencial('u-admin', 'ADMIN', 'eduardo');
    const credencial = await credencialPorLogin(db, 'eduardo');
    expect(credencial?.claveHash).toBeDefined();
    expect(credencial?.claveHash).not.toContain(CLAVE);
  });
});

describe('el respaldo de la clave compartida', () => {
  it('abre como panel mientras ADMIN_ACCESS_KEY este puesta', () => {
    process.env.ADMIN_ACCESS_KEY = 'una-clave-compartida-de-transicion';
    resetEnvForTests();

    expect(claveCompartidaValida('una-clave-compartida-de-transicion')).toEqual({ uid: 'panel', rol: 'ADMIN' });
    expect(claveCompartidaValida('otra')).toBeUndefined();
  });

  /**
   * Lo que lo vuelve una transicion y no una puerta trasera: al borrar la
   * variable el camino desaparece, sin tocar codigo ni desplegar nada.
   */
  it('desaparece solo al borrar la variable', () => {
    delete process.env.ADMIN_ACCESS_KEY;
    resetEnvForTests();

    expect(claveCompartidaValida('una-clave-compartida-de-transicion')).toBeUndefined();
    expect(claveCompartidaValida('')).toBeUndefined();
  });
});

/**
 * El piso del largo de la clave.
 *
 * No es una preferencia de estilo: es lo unico que separa la clave de caer por
 * fuerza bruta, dado que el bloqueo deja pasar ~480 intentos por dia.
 */
describe('el largo minimo de la clave', () => {
  const INTENTOS_POR_DIA = (60 / BLOQUEO_MINUTOS) * MAX_INTENTOS * 24;

  it('deja pasar menos de 500 intentos por dia', () => {
    // Cinco intentos cada quince minutos. Es el techo contra el que se mide
    // cualquier largo que se elija.
    expect(INTENTOS_POR_DIA).toBeLessThan(500);
  });

  /**
   * La cuenta que fija el piso: un PIN de cuatro digitos son 10.000
   * combinaciones y a ese ritmo cae en tres semanas, bloqueo incluido. Por eso
   * el minimo no puede bajar de ocho por comodidad.
   */
  it('un PIN de cuatro digitos caeria en semanas, y por eso hay piso', () => {
    const diasEnCaer = 10_000 / INTENTOS_POR_DIA;

    expect(diasEnCaer).toBeLessThan(30);
    expect(LARGO_MINIMO_CLAVE).toBeGreaterThanOrEqual(8);
  });

  /** El caso borde: una clave de exactamente el minimo tiene que funcionar. */
  it('una clave del largo minimo exacto se guarda y verifica', async () => {
    const clave = 'Tr3n-As3o';
    expect(clave).toHaveLength(LARGO_MINIMO_CLAVE + 1);

    const hash = await hashDeClave(clave.slice(0, LARGO_MINIMO_CLAVE));
    expect(await verificarClave(clave.slice(0, LARGO_MINIMO_CLAVE), hash)).toBe(true);
    expect(await verificarClave(clave.slice(0, LARGO_MINIMO_CLAVE - 1), hash)).toBe(false);
  });
});
