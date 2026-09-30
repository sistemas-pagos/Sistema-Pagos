import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { crearSesion, leerSesion, verifyAdminAccessKey } from '@/src/auth/session';
import { isSameOriginRequest } from '@/src/auth/guard';
import nextConfig from '@/next.config';

beforeEach(() => {
  process.env.ADMIN_ACCESS_KEY = 'synthetic-admin-key-that-is-not-production';
  process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-that-is-not-production';
  resetEnvForTests();
});

afterEach(() => {
  delete process.env.ADMIN_ACCESS_KEY;
  delete process.env.AUTH_SESSION_SECRET;
  resetEnvForTests();
});

describe('admin authentication', () => {
  it('rejects unauthorized access keys', () => {
    expect(verifyAdminAccessKey('wrong-key')).toBe(false);
    expect(verifyAdminAccessKey('synthetic-admin-key-that-is-not-production')).toBe(true);
  });

  it('signs sessions and rejects tampering or expiration', () => {
    const now = new Date('2026-09-08T18:00:00.000Z');
    const token = crearSesion({ uid: 'u-admin', rol: 'ADMIN' }, now);
    expect(leerSesion(token, new Date('2026-09-08T18:01:00.000Z'))).toEqual({ uid: 'u-admin', rol: 'ADMIN' });
    expect(leerSesion(`${token}tampered`, now)).toBeUndefined();
    expect(leerSesion(token, new Date('2026-09-09T03:00:00.000Z'))).toBeUndefined();
  });

  /**
   * La sesion lleva el rol, asi que una sesion falsificable seria una forma de
   * ascenderse solo. La firma es HMAC sobre el payload completo: cambiar el rol
   * cambia el payload y la firma deja de cuadrar.
   */
  it('no se puede ascender de rol editando la sesion', () => {
    const now = new Date('2026-09-08T18:00:00.000Z');
    const token = crearSesion({ uid: 'u-cobrador', rol: 'COBRADOR' }, now);
    const [payload, firma] = token.split('.');

    const adulterado = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    adulterado.rol = 'ADMIN';
    const otroPayload = Buffer.from(JSON.stringify(adulterado), 'utf8').toString('base64url');

    expect(leerSesion(`${otroPayload}.${firma}`, now)).toBeUndefined();
    expect(leerSesion(token, now)).toEqual({ uid: 'u-cobrador', rol: 'COBRADOR' });
  });

  it('un rol que no existe no abre nada', () => {
    const now = new Date('2026-09-08T18:00:00.000Z');
    // Se firma de verdad, con el mismo secreto: lo que se rechaza es el rol.
    const token = crearSesion({ uid: 'u-x', rol: 'SUPERADMIN' as never }, now);
    expect(leerSesion(token, now)).toBeUndefined();
  });
});

/**
 * El chequeo de mismo origen, que no tenia ni una prueba — y por eso el panel
 * entero se fue a produccion devolviendo 403.
 *
 * La causa no estaba aca sino en `next.config.ts`: con `Referrer-Policy:
 * no-referrer` el navegador manda literalmente `Origin: null` en los POST de
 * formulario. `new URL('null')` falla, el catch devolvia `false`, y las siete
 * rutas del panel respondian "Forbidden" sin decir por que. En todos los
 * navegadores, no en uno.
 */
describe('la peticion tiene que venir del propio sitio', () => {
  const SITIO = 'https://pagos.example.com';
  const peticion = (headers: Record<string, string>) =>
    new Request(`${SITIO}/api/admin/login`, { method: 'POST', headers });

  it('acepta un Origin del mismo sitio', () => {
    expect(isSameOriginRequest(peticion({ origin: SITIO }))).toBe(true);
  });

  it('rechaza el Origin de otro sitio', () => {
    expect(isSameOriginRequest(peticion({ origin: 'https://otro.example.com' }))).toBe(false);
  });

  /** El caso que rompio el panel. */
  it('rechaza `Origin: null` sin depender de que new URL falle', () => {
    expect(isSameOriginRequest(peticion({ origin: 'null' }))).toBe(false);
  });

  it('rechaza un Origin que no es una URL', () => {
    expect(isSameOriginRequest(peticion({ origin: 'no-es-una-url' }))).toBe(false);
  });

  it('sin Origin, el Referer del mismo sitio alcanza', () => {
    expect(isSameOriginRequest(peticion({ referer: `${SITIO}/login` }))).toBe(true);
  });

  it('sin Origin, un Referer ajeno no alcanza', () => {
    expect(isSameOriginRequest(peticion({ referer: 'https://otro.example.com/login' }))).toBe(false);
  });

  it('sin Origin ni Referer, falla cerrado', () => {
    expect(isSameOriginRequest(peticion({}))).toBe(false);
  });

  it('el puerto cuenta: otro puerto es otro origen', () => {
    expect(isSameOriginRequest(peticion({ origin: 'https://pagos.example.com:8443' }))).toBe(false);
  });
});

/**
 * La regresion vive en la configuracion, no en la funcion: mientras la cabecera
 * sea `no-referrer`, el navegador manda `Origin: null` y el panel vuelve a
 * romperse sin que ninguna prueba de la funcion lo note.
 */
describe('la cabecera que rompio el panel', () => {
  it('Referrer-Policy no vuelve a ser no-referrer', async () => {
    const reglas = await nextConfig.headers!();
    const politica = reglas
      .flatMap((regla) => regla.headers)
      .find((cabecera) => cabecera.key === 'Referrer-Policy');

    expect(politica).toBeDefined();
    expect(politica?.value).not.toBe('no-referrer');
  });
});
