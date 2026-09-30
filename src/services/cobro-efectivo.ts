import { BASE_PERIOD } from '@/src/services/period-assignment';
import { periodFromDate, shiftPeriod } from '@/src/domain/periods';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';

/**
 * Que meses debe una casa, y cuanto cuesta cada uno.
 *
 * El cobrador no escribe el monto: marca meses y el total sale de aqui. Eso es
 * lo que hace imposible un cobro incompleto — la regla de Eduardo es todo o
 * nada por mes — y de paso elimina los errores de tipeo en la calle.
 *
 * La cuota se resuelve **mes por mes**: `cuotas` tiene `vigente_desde`, asi que
 * agosto y septiembre pueden costar distinto. Multiplicar por la cuota de hoy
 * daria un numero equivocado en cuanto suba.
 */
export interface MesCobrable {
  periodo: string;
  montoCentavos: number;
  /** Ya lo cubre otro pago. Se muestra para explicar, nunca para cobrarlo. */
  yaPagado: boolean;
}

/** Estados que dejan el mes libre (invariante 5). */
const LIBERAN = new Set<PaymentRecord['status']>(['NO_ENCONTRADO', 'RECHAZADO', 'DUPLICADO', 'ANULADO']);

function aCentavos(monto: number): number {
  return Math.round(monto * 100);
}

/**
 * Los meses de servicio de una vivienda, del mas viejo al mas nuevo.
 *
 * Nunca antes de `BASE_PERIOD` ni antes del alta de la casa: la deuda anterior
 * no es un mes, es un `SALDO_INICIAL` (docs/PLAN.md, seccion 1). Y nunca
 * despues del mes en curso — no se cobra por adelantado.
 */
export function mesesDeLaVivienda(home: HomeRecord, hoy: Date): string[] {
  const alta = home.startDate ? periodFromDate(new Date(home.startDate)) : BASE_PERIOD;
  const desde = alta > BASE_PERIOD ? alta : BASE_PERIOD;
  const hasta = periodFromDate(hoy);
  if (desde > hasta) return [];

  const meses: string[] = [];
  for (let periodo = desde; periodo <= hasta; periodo = shiftPeriod(periodo, 1)) {
    meses.push(periodo);
    // Cinturon: una fecha de alta absurda no puede colgar el proceso.
    if (meses.length > 240) break;
  }
  return meses;
}

/**
 * Que puede cobrar el cobrador en esta casa, y a que precio.
 *
 * Los meses ya pagados vienen marcados en vez de omitidos: el cobrador tiene
 * que poder decirle al vecino «septiembre ya lo pagaste por transferencia el
 * 15», que es justo el caso que Eduardo queria resolver.
 */
export function mesesCobrables(
  home: HomeRecord,
  pagosDeLaVivienda: readonly PaymentRecord[],
  hoy: Date,
): MesCobrable[] {
  const ocupados = new Set(
    pagosDeLaVivienda
      .filter((pago) => !LIBERAN.has(pago.status) && pago.period)
      .map((pago) => pago.period),
  );

  return mesesDeLaVivienda(home, hoy).map((periodo) => ({
    periodo,
    montoCentavos: aCentavos(home.monthlyFee),
    yaPagado: ocupados.has(periodo),
  }));
}

export interface SeleccionDeMeses {
  meses: { periodo: string; montoCentavos: number }[];
  totalCentavos: number;
}

export class CobroInvalido extends Error {}

/**
 * Valida lo que el cobrador marco y calcula el total.
 *
 * Rechaza un mes que ya esta pagado, uno que no le corresponde a esta casa, y
 * los repetidos. Que la pantalla no los ofrezca no alcanza: el formulario viaja
 * por HTTP y puede llegar cualquier cosa.
 */
export function seleccionarMeses(
  cobrables: readonly MesCobrable[],
  elegidos: readonly string[],
): SeleccionDeMeses {
  if (elegidos.length === 0) throw new CobroInvalido('Elegí al menos un mes.');
  if (new Set(elegidos).size !== elegidos.length) throw new CobroInvalido('Hay un mes repetido.');

  const porPeriodo = new Map(cobrables.map((mes) => [mes.periodo, mes]));
  const meses = elegidos.map((periodo) => {
    const mes = porPeriodo.get(periodo);
    if (!mes) throw new CobroInvalido(`El mes ${periodo} no corresponde a esta vivienda.`);
    if (mes.yaPagado) throw new CobroInvalido(`${periodo} ya está pagado.`);
    return { periodo, montoCentavos: mes.montoCentavos };
  });

  // Del mas viejo al mas nuevo: la deuda se salda en orden, no salteada.
  meses.sort((a, b) => a.periodo.localeCompare(b.periodo));

  return { meses, totalCentavos: meses.reduce((suma, mes) => suma + mes.montoCentavos, 0) };
}
