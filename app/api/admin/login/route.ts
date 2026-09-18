import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isDemoMode } from '@/src/config/env';
import { isSameOriginRequest } from '@/src/auth/guard';
import { BLOQUEO_MINUTOS, estadoDelOrigen, huellaDeOrigen, limpiarIntentos, origenDeLaPeticion, registrarFallo } from '@/src/auth/intentos';
import { ADMIN_COOKIE_OPTIONS, ADMIN_SESSION_COOKIE, createAdminSession, verifyAdminAccessKey } from '@/src/auth/session';
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
  const accessKey = String(form.get('accessKey') ?? '');
  if (!verifyAdminAccessKey(accessKey)) {
    const bloqueado = await registrarFallo(db, huella, ahora, ACTOR);
    const destino = bloqueado ? `/login?error=bloqueado&minutos=${BLOQUEO_MINUTOS}` : '/login?error=1';
    return NextResponse.redirect(new URL(destino, request.url), 303);
  }

  await limpiarIntentos(db, huella);
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, createAdminSession(), ADMIN_COOKIE_OPTIONS);
  return NextResponse.redirect(new URL('/admin', request.url), 303);
}
