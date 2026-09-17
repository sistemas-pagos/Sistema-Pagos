import { maskReference } from '@/src/security/logging';
import { periodLabel } from './periods';
import type { MetodoPago } from './types';

/**
 * El contenido del recibo que se le envia al vecino (docs/PLAN.md, fase 4).
 *
 * Va aparte de la base y del cliente de WhatsApp a proposito: el orden de los
 * parametros de la plantilla es un contrato con Meta y se prueba sin tocar red
 * ni SQLite.
 *
 * La plantilla a aprobar en Meta tiene este cuerpo, y el orden de los {{n}}
 * es el que devuelve `parametrosDePlantilla`:
 *
 *   Recibo {{1}}
 *   Vivienda: {{2}}
 *   Mes: {{3}}
 *   Monto: {{4}}
 *   Forma de pago: {{5}}
 *   Referencia: {{6}}
 *   Fecha de pago: {{7}}
 *   Verificado: {{8}}
 *
 * Si el texto aprobado cambia el orden, cambia aqui y no en el script: el
 * script solo pasa la lista.
 */
export interface DatosRecibo {
  numero: number;
  vivienda: string;
  periodos: string[];
  montoCentavos: number;
  metodo: MetodoPago;
  referencia?: string;
  fechaPago?: string;
  verificadoEn: string;
}

const METODO_LEGIBLE: Record<MetodoPago, string> = {
  TRANSFERENCIA: 'Transferencia',
  EFECTIVO: 'Efectivo',
};

/** Formato de presentacion del numero de recibo. */
export function formatoRecibo(numero: number): string {
  return `REC-${String(numero).padStart(6, '0')}`;
}

/**
 * El dinero se guarda en centavos enteros (invariante 7) y solo se divide aqui,
 * al mostrarlo. Nunca al reves: un monto que entra como decimal pierde precision.
 */
export function montoEnLempiras(centavos: number): string {
  const lempiras = (centavos / 100).toLocaleString('es-HN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `L${lempiras}`;
}

/**
 * Los meses que cubre el pago, en palabras. Un monto multiplo de la cuota se
 * reparte en varios meses atrasados (invariante 6), asi que el recibo tiene que
 * poder nombrar mas de uno.
 */
export function listaDeMeses(periodos: string[]): string {
  const meses = periodos.map((periodo) => periodLabel(periodo));
  if (meses.length === 0) return '—';
  if (meses.length === 1) return meses[0];
  return `${meses.slice(0, -1).join(', ')} y ${meses[meses.length - 1]}`;
}

/** `2026-09-05` o una fecha ISO completa, siempre como `05/09/2026`. */
export function fechaLegible(valor: string | undefined): string {
  if (!valor) return '—';
  const [fecha] = valor.split('T');
  const partes = fecha.split('-');
  if (partes.length !== 3) return valor;
  const [anio, mes, dia] = partes;
  return `${dia}/${mes}/${anio}`;
}

/**
 * Los ocho parametros de la plantilla, en orden.
 *
 * La referencia va enmascarada: el vecino reconoce su deposito por los ultimos
 * cuatro digitos y el mensaje no lleva el numero completo, que puede quedar
 * reenviado en cualquier chat.
 */
export function parametrosDePlantilla(datos: DatosRecibo): string[] {
  return [
    formatoRecibo(datos.numero),
    datos.vivienda,
    listaDeMeses(datos.periodos),
    montoEnLempiras(datos.montoCentavos),
    METODO_LEGIBLE[datos.metodo],
    maskReference(datos.referencia) ?? '—',
    fechaLegible(datos.fechaPago),
    fechaLegible(datos.verificadoEn),
  ];
}
