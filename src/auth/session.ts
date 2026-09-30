import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env, requireProductionEnv } from '@/src/config/env';
import type { RolUsuario } from '@/src/storage/usuarios';

export const ADMIN_SESSION_COOKIE = 'payments_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * La sesion dice **quien** entro y **con que rol**, no solo que alguien entro.
 *
 * Mientras la clave era compartida, `eventos` no podia anotar mas que "panel"
 * como actor (PR #21), y no habia forma de darle acceso al cobrador sin darle
 * tambien la de verificar transferencias. Las dos cosas se arreglan aca.
 */
export interface Sesion {
  uid: string;
  rol: RolUsuario;
}

interface SessionPayload extends Sesion {
  v: 2;
  exp: number;
}

/**
 * El actor que se anota cuando alguien entra por el respaldo de
 * `ADMIN_ACCESS_KEY`. Se llama "panel" y no como una persona porque esa clave
 * es compartida: decir mas seria inventar quien fue.
 */
export const UID_CLAVE_COMPARTIDA = 'panel';

const ROLES: ReadonlySet<string> = new Set(['ADMIN', 'TESORERO', 'COBRADOR']);

function secret(): string {
  return requireProductionEnv('AUTH_SESSION_SECRET').AUTH_SESSION_SECRET;
}

function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

/**
 * El respaldo de la clave compartida. Sigue existiendo **solo mientras
 * `ADMIN_ACCESS_KEY` este configurada**: es el puente para no quedarse afuera
 * entre este despliegue y crear el primer usuario. Al borrar la variable, el
 * camino desaparece sin tocar codigo.
 */
export function claveCompartidaConfigurada(): boolean {
  return Boolean(env().ADMIN_ACCESS_KEY);
}

export function verifyAdminAccessKey(provided: string): boolean {
  const expected = env().ADMIN_ACCESS_KEY;
  if (!expected) return false;
  return Boolean(provided) && safeTextEqual(provided, expected);
}

export function crearSesion(sesion: Sesion, now = new Date()): string {
  const payload: SessionPayload = {
    v: 2,
    uid: sesion.uid,
    rol: sesion.rol,
    exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded)}`;
}

/**
 * Devuelve quien es, o `undefined`. Una sesion de la version anterior no se
 * acepta: no dice quien ni con que rol, y adivinarlo seria darle a alguien un
 * permiso que nadie le dio.
 */
export function leerSesion(token: string | undefined, now = new Date()): Sesion | undefined {
  if (!token) return undefined;
  const [encoded, providedSignature, extra] = token.split('.');
  if (!encoded || !providedSignature || extra) return undefined;
  if (!safeTextEqual(providedSignature, signature(encoded))) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (payload.v !== 2) return undefined;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now.getTime() / 1000)) return undefined;
    if (typeof payload.uid !== 'string' || payload.uid === '') return undefined;
    if (typeof payload.rol !== 'string' || !ROLES.has(payload.rol)) return undefined;
    return { uid: payload.uid, rol: payload.rol as RolUsuario };
  } catch {
    return undefined;
  }
}

export const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_TTL_SECONDS,
};
