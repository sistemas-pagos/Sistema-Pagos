import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isDemoMode } from '@/src/config/env';
import { isSameOriginRequest, ROLES_DE_COBROS } from '@/src/auth/guard';
import { BLOQUEO_MINUTOS, estadoDelOrigen, huellaDeOrigen, limpiarIntentos, origenDeLaPeticion, registrarFallo } from '@/src/auth/intentos';
import { claveCompartidaValida, credencialValida } from '@/src/auth/credenciales';
import { ADMIN_COOKIE_OPTIONS, ADMIN_SESSION_COOKIE, crearSesion } from '@/src/auth/session';
import { getTursoClient } from '@/src/storage/turso-client';

export const runtime = 'nodejs';

const ACTOR = 'panel:login';

export async function POST(request: Request) {
  if (isDemoMode()) return NextResponse.redirect(new URL('/', request.url), 303);
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  // Sin base no hay login. Es a proposito: un limite que se cae solo cuando la
  // base no responde desaparece justo cuando serviria. Y no quita nada — el
  // panel lee los pagos de Turso, asi que sin base ya no habia nada que ver
  // despues de entrar.
  const db = await getTursoClient();
  const huella = huellaDeOrigen(origenDeLaPeticion(request));
  const ahora = new Date();

  // El bloqueo se mira antes de comparar la clave: a un origen bloqueado no se
  // le compara nada. Comprobarla primero y rechazar despues seguiria
  // respondiendo distinto segun si la clave era buena, que es exactamente la
  // señal que el bloqueo viene a cortar.
  const estado = await estadoDelOrigen(db, huella, ahora);
  if (estado.bloqueado) {
    return NextResponse.redirect(new URL(`/login?error=bloqueado&minutos=${estado.minutosRestantes}`, request.url), 303);
  }

  const form = await request.formData();
  const login = String(form.get('usuario') ?? '').trim();
  const clave = String(form.get('accessKey') ?? '');

  // Con usuario se busca la persona; sin usuario queda el respaldo de la clave
  // compartida, que solo existe mientras ADMIN_ACCESS_KEY este configurada.
  const sesion = login
    ? await credencialValida(db, login, clave)
    : claveCompartidaValida(clave);

  if (!sesion) {
    const bloqueado = await registrarFallo(db, huella, ahora, ACTOR);
    const destino = bloqueado ? `/login?error=bloqueado&minutos=${BLOQUEO_MINUTOS}` : '/login?error=1';
    return NextResponse.redirect(new URL(destino, request.url), 303);
  }

  await limpiarIntentos(db, huella);
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, crearSesion(sesion), ADMIN_COOKIE_OPTIONS);

  // Cada quien a lo suyo: el cobrador no tiene nada que hacer en el panel y no
  // deberia verlo ni de paso.
  const destino = sesion.rol === 'COBRADOR' && ROLES_DE_COBROS.includes(sesion.rol) ? '/cobros' : '/admin';
  return NextResponse.redirect(new URL(destino, request.url), 303);
}
