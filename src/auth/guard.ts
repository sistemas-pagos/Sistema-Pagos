import { cookies } from 'next/headers';
import { isDemoMode } from '@/src/config/env';
import type { RolUsuario } from '@/src/storage/usuarios';
import { ADMIN_SESSION_COOKIE, leerSesion, UID_CLAVE_COMPARTIDA, type Sesion } from './session';

/** Quien manda el extracto del banco y quien verifica: el trabajo de escritorio. */
export const ROLES_DEL_PANEL: readonly RolUsuario[] = ['ADMIN', 'TESORERO'];
/** Quien cobra en la calle. Un ADMIN tambien entra, para probar y para corregir. */
export const ROLES_DE_COBROS: readonly RolUsuario[] = ['ADMIN', 'COBRADOR'];

/**
 * Quien esta usando el panel, o `undefined`.
 *
 * En la demostracion no hay base ni sesion: se devuelve un ADMIN ficticio para
 * que las pantallas se puedan mirar, igual que antes.
 */
export async function sesionActual(): Promise<Sesion | undefined> {
  if (isDemoMode()) return { uid: UID_CLAVE_COMPARTIDA, rol: 'ADMIN' };
  const cookieStore = await cookies();
  return leerSesion(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
}

/**
 * Falla cerrado: sin sesion, o con un rol que no esta en la lista, es `false`.
 * Quien no tiene permiso no se entera de que la pagina existe — se le manda al
 * login, no a un mensaje que le confirme que hay algo detras.
 */
export async function tieneRol(...roles: readonly RolUsuario[]): Promise<boolean> {
  const sesion = await sesionActual();
  return sesion !== undefined && roles.includes(sesion.rol);
}

export async function isAdminAuthenticated(): Promise<boolean> {
  return tieneRol(...ROLES_DEL_PANEL);
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
