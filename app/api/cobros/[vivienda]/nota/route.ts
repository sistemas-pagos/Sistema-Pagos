import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ROLES_DE_COBROS, isSameOriginRequest, sesionActual } from '@/src/auth/guard';
import { getPaymentStore } from '@/src/storage';
import { dejarNota } from '@/src/storage/notas';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * Lo que el cobrador quiere decir sobre un pago que no puede tocar.
 *
 * El cobrador no edita, no rechaza y no anula: eso es del admin. Sin esta ruta
 * la separacion de permisos lo dejaria mudo justo cuando es el unico que estuvo
 * en la puerta y sabe que paso.
 */
export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ vivienda: string }> }) {
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  const sesion = await sesionActual();
  if (!sesion || !ROLES_DE_COBROS.includes(sesion.rol)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { vivienda: viviendaId } = await params;
  const form = await request.formData();
  const pagoId = String(form.get('pagoId') ?? '');
  const texto = String(form.get('texto') ?? '').trim();
  const volver = (query: string) =>
    NextResponse.redirect(new URL(`/cobros/${viviendaId}${query}`, request.url), 303);

  if (!texto) return volver('?error=Escribí qué pasó antes de guardar la nota.');

  const store = await getPaymentStore();
  const [homes, pago] = await Promise.all([store.listHomes(), store.getPayment(pagoId)]);
  const home = homes.find((candidata) => candidata.id === viviendaId);
  if (!home || !home.active) return new NextResponse('Not found', { status: 404 });

  // El pago tiene que ser de **esta** casa. Sin esta comprobacion, el id que
  // viaja en el formulario dejaria dejar notas sobre el pago de cualquier
  // vecino, que es exactamente el dato que el cobrador no debe alcanzar.
  const esDeLaCasa = pago !== undefined
    && pago.stage === home.stage && pago.block === home.block && pago.house === home.house;
  if (!esDeLaCasa) return new NextResponse('Not found', { status: 404 });

  await dejarNota(await getTursoClient(), {
    id: randomUUID(),
    pagoId,
    autorId: sesion.uid,
    texto,
    creadaEn: new Date().toISOString(),
  });

  return volver('?nota=1');
}
