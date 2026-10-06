import { compareHomes, homeCode } from '@/src/domain/housing';
import { firstBillablePeriod, mesesDelPago } from '@/src/services/period-assignment';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';

/**
 * Lo que el cobrador ve de cada casa: **estado, no datos**.
 *
 * Nunca el nombre del depositante, ni el telefono de otro vecino, ni el monto
 * de otra casa. El cobrador necesita saber si esa puerta debe o no, y por que
 * medio pago si ya lo hizo — nada mas. Menos informacion dando vueltas es
 * menos informacion que se puede filtrar (invariante 12).
 */
export type EstadoDeCasa = 'PENDIENTE' | 'PAGADO' | 'POR_VERIFICAR' | 'EN_REVISION';

export interface FilaDeCobro {
  viviendaId: string;
  codigo: string;
  stage: string;
  block: string;
  house: string;
  estado: EstadoDeCasa;
  /**
   * Si la casa paga el servicio.
   *
   * Una casa inactiva —vacia, exonerada, o simplemente una que no paga— no
   * debe el mes, pero **aparece igual en la lista**: el cobrador tiene que
   * poder verla para saber que existe y que no le toca tocar esa puerta, y
   * para que se puedan contar.
   */
  activa: boolean;
  /** `EFECTIVO`, `TRANSFERENCIA` o undefined si todavia no pago. */
  metodo?: PaymentRecord['method'];
  /** Ultimos digitos, para el vecino que dice «ya pagué, aquí está mi número». */
  referencia?: string;
  fechaPago?: string;
}

export interface FiltrosDeCobro {
  stage?: string;
  block?: string;
  house?: string;
  estado?: EstadoDeCasa;
  /** `true` solo activas, `false` solo inactivas, `undefined` todas. */
  activa?: boolean;
  metodo?: PaymentRecord['method'];
  /** Lo unico que se escribe. Busca por referencia o por numero de recibo. */
  busqueda?: string;
}

const LIBERAN = new Set<PaymentRecord['status']>(['NO_ENCONTRADO', 'RECHAZADO', 'DUPLICADO', 'ANULADO']);

function estadoDelPago(pago: PaymentRecord): EstadoDeCasa | undefined {
  if (pago.status === 'VERIFICADO' || pago.status === 'EFECTIVO_COBRADO') return 'PAGADO';
  if (pago.status === 'PENDIENTE_VERIFICACION') return 'POR_VERIFICAR';
  if (pago.status === 'EN_REVISION' || pago.status === 'ESPERANDO_RESPUESTA') return 'EN_REVISION';
  return undefined;
}

/** El estado que gana cuando hay varios pagos: pagado manda sobre lo demas. */
const PRIORIDAD: Record<EstadoDeCasa, number> = {
  PAGADO: 3, POR_VERIFICAR: 2, EN_REVISION: 1, PENDIENTE: 0,
};

/**
 * Una fila por vivienda activa, para el mes elegido.
 *
 * Se parte del padron y no de los pagos: una casa que no pago tiene que
 * aparecer igual, porque es justamente a la que hay que ir a tocarle la puerta.
 */
export function filasDeCobro(
  homes: readonly HomeRecord[],
  pagos: readonly PaymentRecord[],
  periodo: string,
  filtros: FiltrosDeCobro = {},
): FilaDeCobro[] {
  const delMes = pagos.filter(
    (pago) => !LIBERAN.has(pago.status) && mesesDelPago(pago).includes(periodo),
  );

  // Una casa no aparece en un mes anterior a su alta.
  //
  // El listado no miraba la fecha de alta y la pantalla de cobro si, asi que se
  // contradecian: la lista decia que la casa debia septiembre y al entrar solo
  // se podia cobrar octubre. El cobrador le tocaba la puerta por un mes que esa
  // casa nunca debio.
  //
  // Las **inactivas si aparecen**. Antes se filtraban aqui y desaparecian de
  // todo, asi que una casa vacia no se podia ni ver ni contar: la unica forma
  // de saber que existia era que alguien se acordara. Aparecen marcadas, y el
  // filtro de arriba deja verlas solas o esconderlas.
  const filas = homes
    .filter((home) => periodo >= firstBillablePeriod(home))
    .map((home): FilaDeCobro => {
      const suyos = delMes.filter(
        (pago) => pago.stage === home.stage && pago.block === home.block && pago.house === home.house,
      );

      let fila: FilaDeCobro = {
        viviendaId: home.id,
        codigo: homeCode(home),
        stage: home.stage,
        block: home.block,
        house: home.house,
        estado: 'PENDIENTE',
        activa: home.active,
      };

      for (const pago of suyos) {
        const estado = estadoDelPago(pago);
        if (!estado || PRIORIDAD[estado] <= PRIORIDAD[fila.estado]) continue;
        fila = {
          ...fila,
          estado,
          metodo: pago.method,
          referencia: pago.reference,
          fechaPago: pago.transactionDate,
        };
      }

      return fila;
    });

  return aplicarFiltros(filas, filtros).sort(compareHomes);
}

function aplicarFiltros(filas: readonly FilaDeCobro[], filtros: FiltrosDeCobro): FilaDeCobro[] {
  const busqueda = filtros.busqueda?.trim().toLowerCase();

  return filas.filter((fila) => {
    if (filtros.stage && fila.stage !== filtros.stage) return false;
    if (filtros.block && fila.block !== filtros.block) return false;
    if (filtros.house && fila.house !== filtros.house) return false;
    if (filtros.estado && fila.estado !== filtros.estado) return false;
    if (filtros.activa !== undefined && fila.activa !== filtros.activa) return false;
    if (filtros.metodo && fila.metodo !== filtros.metodo) return false;

    // La referencia se busca **por el final**: el vecino lee los ultimos
    // digitos de su comprobante. Buscar en cualquier posicion parece mas
    // generoso pero devuelve basura — `0000` aparece en medio de casi toda
    // referencia del BAC. El codigo de vivienda si se busca por partes, porque
    // ahi lo natural es escribir `e3b2`.
    if (busqueda) {
      const referencia = fila.referencia?.toLowerCase() ?? '';
      const codigo = fila.codigo.toLowerCase();
      if (!referencia.endsWith(busqueda) && !codigo.includes(busqueda)) return false;
    }

    return true;
  });
}

/**
 * Las opciones de cada lista desplegable, sacadas del padron entero.
 *
 * Incluye las inactivas a proposito: si el bloque de una casa vacia no esta en
 * la lista, no hay forma de llegar hasta ella para verla.
 */
export function opcionesDeFiltro(homes: readonly HomeRecord[]): {
  etapas: string[];
  bloques: string[];
  casas: string[];
} {
  const unicos = (valores: string[]) => [...new Set(valores)].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

  return {
    etapas: unicos(homes.map((home) => home.stage)),
    bloques: unicos(homes.map((home) => home.block)),
    casas: unicos(homes.map((home) => home.house)),
  };
}
