import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/src/config/env';
import { ROLES_DE_COBROS, isSameOriginRequest, sesionActual } from '@/src/auth/guard';
import { normalizeOptionalPhone } from '@/src/domain/phone';
import { CobroInvalido, mesesCobrables, seleccionarMeses } from '@/src/services/cobro-efectivo';
import { getPaymentStore } from '@/src/storage';
import { registrarCobroEnEfectivo, registrarCobroEnRevision } from '@/src/storage/efectivo';
import { getTursoClient } from '@/src/storage/turso-client';
import { requestReceiptSending } from '@/src/whatsapp/dispatch';

export const runtime = 'nodejs';

function volver(request: Request, viviendaId: string, query: string): NextResponse {
  return NextResponse.redirect(new URL(`/cobros/${viviendaId}${query}`, request.url), 303);
}

export async function POST(request: Request, { params }: { params: Promise<{ vivienda: string }> }) {
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  const sesion = await sesionActual();
  if (!sesion || !ROLES_DE_COBROS.includes(sesion.rol)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { vivienda: viviendaId } = await params;
  const store = await getPaymentStore();
  const [homes, pagos] = await Promise.all([store.listHomes(), store.listPayments()]);
  const home = homes.find((candidata) => candidata.id === viviendaId);
  if (!home || !home.active) return new NextResponse('Not found', { status: 404 });

  const form = await request.formData();
  const telefono = normalizeOptionalPhone(String(form.get('telefono') ?? ''));
  const aceptaWhatsapp = form.get('consiente') === 'on';
  const ahora = new Date();
  const creadoEn = ahora.toISOString();
  const fechaPago = creadoEn.slice(0, 10);

  const suyos = pagos.filter(
    (pago) => pago.stage === home.stage && pago.block === home.block && pago.house === home.house,
  );
  const cobrables = mesesCobrables(home, suyos, ahora);
  const db = await getTursoClient();

  // La casa ya pago y el cobrador igual recibio la plata. Se registra sin tomar
  // el mes, sin recibo y sin avisarle al vecino: no anotarlo dejaria dinero
  // existiendo que el sistema no conoce, que es peor.
  if (form.get('enRevision') === '1') {
    const motivo = String(form.get('motivo') ?? '').trim();
    if (!motivo) return volver(request, viviendaId, '?error=Contá qué pasó antes de registrarlo.');

    const cuota = cobrables[0]?.montoCentavos ?? Math.round(home.monthlyFee * 100);
    await registrarCobroEnRevision(db, {
      pagoId: randomUUID(),
      viviendaId,
      meses: [{ periodo: cobrables[cobrables.length - 1]?.periodo ?? fechaPago.slice(0, 7), montoCentavos: cuota }],
      cobradorId: sesion.uid,
      telefono,
      aceptaWhatsapp,
      fechaPago,
      creadoEn,
      motivo,
    }, sesion.uid);

    return volver(request, viviendaId, '?revision=1');
  }

  let seleccion;
  try {
    seleccion = seleccionarMeses(cobrables, form.getAll('meses').map(String));
  } catch (error) {
    const mensaje = error instanceof CobroInvalido ? error.message : 'No se pudo registrar el cobro.';
    return volver(request, viviendaId, `?error=${encodeURIComponent(mensaje)}`);
  }

  let reciboNumero: number;
  try {
    ({ reciboNumero } = await registrarCobroEnEfectivo(db, {
      pagoId: randomUUID(),
      viviendaId,
      meses: seleccion.meses,
      cobradorId: sesion.uid,
      telefono,
      aceptaWhatsapp,
      fechaPago,
      plantilla: env().WHATSAPP_TEMPLATE_RECIBO,
      creadoEn,
    }, sesion.uid));
  } catch (error) {
    // La UNIQUE de `pago_meses` salta si alguien tomo el mes entremedio: el
    // vecino pago por transferencia mientras el cobrador estaba en la puerta.
    const choque = error instanceof Error && /UNIQUE/i.test(error.message);
    const mensaje = choque
      ? 'Alguien tomó ese mes mientras registrabas. Volvé a mirar el estado de la casa.'
      : 'No se pudo registrar el cobro.';
    return volver(request, viviendaId, `?error=${encodeURIComponent(mensaje)}`);
  }

  // El recibo sale ya, no en la proxima corrida del cron: el vecino no recibe
  // nada de papel y esperar dos horas por su unico comprobante no sirve.
  if (telefono && aceptaWhatsapp) await requestReceiptSending();

  return volver(request, viviendaId, `?recibo=${reciboNumero}`);
}
