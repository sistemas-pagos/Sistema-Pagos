import { cookies } from 'next/headers';
import { isDemoMode } from '@/src/config/env';
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from './session';

export async function isAdminAuthenticated(): Promise<boolean> {
  if (isDemoMode()) return true;
  const cookieStore = await cookies();
  return verifyAdminSession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
