import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ROLES_DEL_PANEL, isSameOriginRequest, sesionActual } from '@/src/auth/guard';
import { UID_CLAVE_COMPARTIDA } from '@/src/auth/session';
import { centavosDesdeLempiras } from '@/src/domain/recibo';
import { cerrarCaja } from '@/src/storage/cierre-caja';
import { cobradoSinEntregar } from '@/src/storage/efectivo';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * El tesorero recibe la plata del cobrador.
 *
 * El monto esperado **no se lee del formulario**: se vuelve a calcular aqui. Si
 * viajara en la peticion, quien la manda podria decir que esperaba justo lo que
 * entrego y ninguna diferencia existiria nunca.
 */
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  const sesion = await sesionActual();
  if (!sesion || !ROLES_DEL_PANEL.includes(sesion.rol)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const form = await request.formData();
  const cobradorId = String(form.get('cobrador') ?? '');
  const volver = (query: string) =>
    NextResponse.redirect(new URL(`/admin/caja${query}`, request.url), 303);
  const conError = (mensaje: string) =>
    volver(`?cobrador=${encodeURIComponent(cobradorId)}&error=${encodeURIComponent(mensaje)}`);

  // La base exige `cobrador_id <> tesorero_id`, y la clave compartida no es una
  // persona: no hay a quien atribuirle haber recibido el dinero.
  if (sesion.uid === UID_CLAVE_COMPARTIDA) {
    return conError('Entrá con tu propio usuario para recibir una caja.');
  }
  if (!cobradorId) return conError('Falta el cobrador.');
  if (cobradorId === sesion.uid) {
    return conError('Nadie recibe lo que él mismo cobró. Que la reciba otra persona.');
  }

  const entregadoCentavos = centavosDesdeLempiras(String(form.get('entregado') ?? ''));
  if (entregadoCentavos === undefined) {
    return conError('Escribí las lempiras recibidas, con punto para los centavos.');
  }

  const db = await getTursoClient();
  const pendiente = await cobradoSinEntregar(db, cobradorId);
  if (pendiente.cobros === 0) return conError('Ese cobrador no tiene nada sin entregar.');

  const { pagosCerrados, diferenciaCentavos } = await cerrarCaja(db, {
    id: randomUUID(),
    cobradorId,
    tesoreroId: sesion.uid,
    montoEsperadoCentavos: pendiente.totalCentavos,
    montoEntregadoCentavos: entregadoCentavos,
    creadoEn: new Date().toISOString(),
  }, sesion.uid);

  return volver(`?cerrado=${pagosCerrados}&diferencia=${diferenciaCentavos}`);
}
