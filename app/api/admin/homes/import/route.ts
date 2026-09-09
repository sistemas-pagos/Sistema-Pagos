import { NextResponse } from 'next/server';
import { isAdminAuthenticated, isSameOriginRequest } from '@/src/auth/guard';
import { HomeImportError, parseHomesImport } from '@/src/services/home-import';
import { getPaymentStore } from '@/src/storage';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return new NextResponse('Unauthorized', { status: 401 });
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  try {
    const form = await request.formData();
    const input = String(form.get('data') ?? '');
    const store = await getPaymentStore();
    const existing = await store.listHomes();
    const homes = parseHomesImport(input, existing);
    await store.saveHomes(homes);
    return NextResponse.redirect(new URL(`/admin/homes?imported=${homes.length}`, request.url), 303);
  } catch (error) {
    if (error instanceof HomeImportError) return new NextResponse(error.message, { status: 400 });
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'home_already_exists' || reason === 'home_address_already_exists') {
      return new NextResponse('La importación contiene una vivienda que ya existe.', { status: 409 });
    }
    return new NextResponse('No se pudo importar la base de viviendas.', { status: 400 });
  }
}
