import { cookies } from 'next/headers';
import { isDemoMode } from '@/src/config/env';
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from './session';

export async function isAdminAuthenticated(): Promise<boolean> {
  if (isDemoMode()) return true;
  const cookieStore = await cookies();
  return verifyAdminSession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
}

function origenDe(valor: string): string | undefined {
  try {
    return new URL(valor).origin;
  } catch {
    return undefined;
  }
}

/**
 * Defensa CSRF del panel: la peticion tiene que salir del propio sitio y no de
 * una pagina ajena que la dispare con la sesion del tesorero abierta.
 *
 * Se mira `Origin` y, si no viene, `Referer`. Los dos los pone el navegador y
 * una pagina de otro sitio no puede falsificarlos.
 *
 * El `null` explicito no es paranoia. Con `Referrer-Policy: no-referrer` el
 * navegador manda literalmente la cadena `Origin: null` en los POST de
 * formulario, y como `new URL('null')` falla, esto devolvia `false` y las siete
 * rutas del panel respondian 403 en **todos** los navegadores. La cabecera ya no
 * es esa (ver `next.config.ts`), pero el caso queda cubierto y probado: el
 * sintoma era un "Forbidden" pelado que no decia por que.
 */
export function isSameOriginRequest(request: Request): boolean {
  const esperado = origenDe(request.url);
  if (!esperado) return false;

  const origin = request.headers.get('origin');
  if (origin) return origin !== 'null' && origenDe(origin) === esperado;

  const referer = request.headers.get('referer');
  return referer !== null && origenDe(referer) === esperado;
}
