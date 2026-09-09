import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { requireProductionEnv } from '@/src/config/env';

export const ADMIN_SESSION_COOKIE = 'payments_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  v: 1;
  exp: number;
}

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

export function verifyAdminAccessKey(provided: string): boolean {
  const expected = requireProductionEnv('ADMIN_ACCESS_KEY').ADMIN_ACCESS_KEY;
  return Boolean(provided) && safeTextEqual(provided, expected);
}

export function createAdminSession(now = new Date()): string {
  const payload: SessionPayload = {
    v: 1,
    exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded)}`;
}

export function verifyAdminSession(token: string | undefined, now = new Date()): boolean {
  if (!token) return false;
  const [encoded, providedSignature, extra] = token.split('.');
  if (!encoded || !providedSignature || extra) return false;
  if (!safeTextEqual(providedSignature, signature(encoded))) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    return payload.v === 1 && typeof payload.exp === 'number' && payload.exp > Math.floor(now.getTime() / 1000);
  } catch {
    return false;
  }
}

export const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_TTL_SECONDS,
};
