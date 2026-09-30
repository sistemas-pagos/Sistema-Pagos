import { NextResponse } from 'next/server';
import { ROLES_DEL_PANEL, isSameOriginRequest, sesionActual } from '@/src/auth/guard';
import { resolverNota } from '@/src/storage/notas';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * Cerrar una nota. No se borra ni se edita: queda con su texto, que es lo que
 * explica por que el pago quedo como quedo (invariante 8).
 */
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  const sesion = await sesionActual();
  if (!sesion || !ROLES_DEL_PANEL.includes(sesion.rol)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  if (!id) return new NextResponse('Bad request', { status: 400 });

  // `false` significa que ya estaba resuelta: dos tesoreros con la bandeja
  // abierta es lo normal, y no es un error que haya que mostrarle a nadie.
  await resolverNota(await getTursoClient(), {
    id,
    resueltaPor: sesion.uid,
    en: new Date().toISOString(),
  });

  return NextResponse.redirect(new URL('/admin/notas?resuelta=1', request.url), 303);
}
