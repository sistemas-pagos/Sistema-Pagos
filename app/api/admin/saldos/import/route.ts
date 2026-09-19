import { NextResponse } from 'next/server';
import { isAdminAuthenticated, isSameOriginRequest } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { SaldosImportError, parseSaldosImport } from '@/src/services/saldos-import';
import { getPaymentStore } from '@/src/storage';
import { registrarAjustes, viviendasConSaldoInicial } from '@/src/storage/ajustes';
import { getTursoClient } from '@/src/storage/turso-client';
import { usuarioResponsable } from '@/src/storage/usuarios';

export const runtime = 'nodejs';

const ACTOR = 'panel:saldos';

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return new NextResponse('Unauthorized', { status: 401 });
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });
  // La demostracion no tiene base: cargar saldos ahi no significaria nada.
  if (isDemoMode()) return new NextResponse('La carga de saldos solo funciona en producción.', { status: 400 });

  try {
    const form = await request.formData();
    const entrada = String(form.get('data') ?? '');

    const db = await getTursoClient();
    // `ajustes.creado_por` apunta a `usuarios`: sin nadie dado de alta, el
    // INSERT fallaria por clave foranea con un error que no explica nada.
    const responsable = await usuarioResponsable(db);
    if (!responsable) {
      return new NextResponse('Primero da de alta un usuario con el workflow «Usuarios».', { status: 409 });
    }

    const store = await getPaymentStore();
    const { ajustes, yaTenian } = parseSaldosImport(entrada, await store.listHomes(), {
      yaTienenSaldo: await viviendasConSaldoInicial(db),
      creadoPor: responsable.id,
      creadoEn: new Date().toISOString(),
    });

    const { registrados } = await registrarAjustes(db, ajustes, ACTOR, new Date().toISOString());
    const destino = `/admin/saldos?cargados=${registrados}&repetidos=${yaTenian}`;
    return NextResponse.redirect(new URL(destino, request.url), 303);
  } catch (error) {
    if (error instanceof SaldosImportError) return new NextResponse(error.message, { status: 400 });
    return new NextResponse('No se pudieron cargar los saldos iniciales.', { status: 400 });
  }
}
