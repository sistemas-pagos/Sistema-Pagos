import type { MonthlyHomeStatusRow } from '@/src/domain/types';
import { buildMonthlyHomeStatus } from '@/src/services/monthly-status';
import type { ResumenDelMes } from '@/src/storage/cierre-mes';
import type { PaymentStore } from '@/src/storage/types';

/**
 * El cuadre del mes: cuantas casas pagaron y cuanto entro de verdad.
 *
 * Se arma desde el estado mensual, que es una vista derivada de viviendas y
 * pagos — nunca una segunda fuente de verdad. Por eso cerrar un mes dos veces
 * daria el mismo numero mientras nada cambie, y por eso el mes se bloquea: si
 * los pagos se pudieran seguir tocando, el cuadre guardado dejaria de
 * corresponder con lo que la base dice, y no habria forma de saber cual de los
 * dos miente.
 */

function centavos(monto: number): number {
  return Math.round(monto * 100);
}

export function resumirMes(filas: readonly MonthlyHomeStatusRow[]): ResumenDelMes {
  const contar = (estado: MonthlyHomeStatusRow['status']) => filas.filter((fila) => fila.status === estado).length;

  return {
    viviendasActivas: filas.length,
    pagadas: contar('PAGADO'),
    porVerificar: contar('POR_VERIFICAR'),
    enRevision: contar('EN_REVISION'),
    pendientes: contar('PENDIENTE'),
    // Solo lo que el banco respaldo: una casa POR_VERIFICAR todavia no pago
    // (invariante 2).
    cobradoCentavos: filas
      .filter((fila) => fila.status === 'PAGADO')
      .reduce((total, fila) => total + centavos(fila.monthlyFee), 0),
    esperadoCentavos: filas.reduce((total, fila) => total + centavos(fila.monthlyFee), 0),
  };
}

export async function calcularCierre(store: PaymentStore, periodo: string): Promise<ResumenDelMes> {
  return resumirMes(await buildMonthlyHomeStatus(store, periodo));
}
