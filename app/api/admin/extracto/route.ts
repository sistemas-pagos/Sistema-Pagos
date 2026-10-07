import { NextResponse } from 'next/server';
import { isSameOriginRequest, sesionActual } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import {
  confirmarExtracto,
  descartarExtracto,
  recibirExtracto,
  type ResultadoConfirmacion,
} from '@/src/services/conciliacion';
import { getPaymentStore } from '@/src/storage';
import { getTursoClient } from '@/src/storage/turso-client';
import { puedeConciliar, usuarioPorId } from '@/src/storage/usuarios';

/**
 * El extracto del banco, cargado desde el panel.
 *
 * Es el **mismo camino** que el de WhatsApp: `recibirExtracto` y
 * `confirmarExtracto` son las mismas funciones que corre el worker. Tener dos
 * logicas segun por que puerta entro el archivo es como aparecen dos verdades
 * en algo que verifica plata.
 *
 * Lo que cambia es por donde llega y como se confirma: un boton con el resumen
 * a la vista, en vez de responder «SI» a un mensaje que vence.
 */
export const runtime = 'nodejs';

/** Un extracto es texto. Un archivo de megas no es un extracto. */
const MAXIMO_BYTES = 2 * 1024 * 1024;

function volver(request: Request, aviso: string): NextResponse {
  return NextResponse.redirect(new URL(`/admin/extracto?aviso=${aviso}`, request.url), 303);
}

/** El codigo que la pantalla sabe redactar. Los numeros van aparte. */
function avisoDe(resultado: ResultadoConfirmacion): string {
  if (resultado.tipo !== 'aplicada') return resultado.tipo;
  const { verificados, recibos, sinRespaldo, aRevision } = resultado;
  return `aplicada&v=${verificados}&r=${recibos}&s=${sinRespaldo}&x=${aRevision}`;
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });
  if (isDemoMode()) return new NextResponse('La conciliación solo funciona en producción.', { status: 400 });

  const sesion = await sesionActual();
  if (!sesion) return new NextResponse('Unauthorized', { status: 401 });

  const db = await getTursoClient();
  // El rol se vuelve a leer de la tabla y no se cree el de la cookie: esto
  // decide quien verifica pagos, y una sesion vieja puede traer un rol que
  // ya le quitaron.
  const usuario = await usuarioPorId(db, sesion.uid);
  if (!puedeConciliar(usuario)) return new NextResponse('Forbidden', { status: 403 });

  const form = await request.formData();
  const accion = String(form.get('accion') ?? '');
  const store = await getPaymentStore();

  if (accion === 'confirmar') return volver(request, avisoDe(await confirmarExtracto({ db, store }, usuario)));
  if (accion === 'descartar') return volver(request, avisoDe(await descartarExtracto({ db, store }, usuario)));

  const archivo = form.get('archivo');
  if (!(archivo instanceof File) || archivo.size === 0) return volver(request, 'sin_archivo');
  if (archivo.size > MAXIMO_BYTES) return volver(request, 'demasiado_grande');

  const resultado = await recibirExtracto({ db, store }, usuario, Buffer.from(await archivo.arrayBuffer()));

  // Por WhatsApp `no_es_extracto` deja seguir el mensaje, porque el tesorero
  // tambien es vecino y pudo mandar su comprobante. Aca eligio el archivo a
  // proposito: hay que decirle que ese no era.
  return volver(request, resultado.tipo === 'no_es_extracto' ? 'no_es_extracto' : resultado.motivo);
}
