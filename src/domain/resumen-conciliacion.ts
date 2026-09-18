import { montoEnLempiras } from '@/src/domain/recibo';
import type { BankMovement, ReconciliationPlan } from '@/src/services/reconciliation';

/**
 * Lo que el tesorero ve antes de escribir "SI".
 *
 * Es el unico momento en que una persona mira la conciliacion entera, asi que
 * tiene que decir las tres cosas que cambian una decision:
 *
 * - cuantos pagos se verificarian;
 * - cuanto dinero entro que nadie reclama, que es lo que hay que salir a
 *   buscar;
 * - cuantos comprobantes quedan sin respaldo del banco.
 *
 * Y no dice de quien es nada de eso. El resumen se guarda en `resumen_json` y
 * viaja por WhatsApp: con contarlo alcanza para decidir, y nombres, viviendas
 * y referencias no tienen por que estar ahi.
 */
export interface ResumenConciliacion {
  /** Depositos (creditos) que trae el extracto. */
  depositos: number;
  depositosCentavos: number;
  verificaria: number;
  verificariaCentavos: number;
  /** Depositos que ningun comprobante reclama. */
  sinComprobante: number;
  sinComprobanteCentavos: number;
  /** Comprobantes cuyo deposito no esta en el extracto. */
  sinDeposito: number;
  aRevision: number;
}

function centavos(monto: number): number {
  return Math.round(monto * 100);
}

function suma(movimientos: readonly BankMovement[]): number {
  return movimientos.reduce((total, movimiento) => total + centavos(movimiento.amount), 0);
}

export function resumirConciliacion(
  plan: ReconciliationPlan,
  movimientos: readonly BankMovement[],
): ResumenConciliacion {
  const verificaria = plan.decisions.filter((decision) => decision.outcome === 'verify');
  const verificados = new Set(verificaria.map((decision) => decision.movementId));

  return {
    depositos: movimientos.length,
    depositosCentavos: suma(movimientos),
    verificaria: verificaria.length,
    verificariaCentavos: suma(movimientos.filter((movimiento) => movimiento.id && verificados.has(movimiento.id))),
    sinComprobante: plan.unclaimedMovements.length,
    sinComprobanteCentavos: suma(plan.unclaimedMovements),
    sinDeposito: plan.decisions.filter((decision) => decision.outcome === 'not_found').length,
    aRevision: plan.decisions.filter((decision) => decision.outcome === 'review').length,
  };
}

function linea(etiqueta: string, cantidad: number, unidad: string, montoCentavos?: number): string {
  const plural = cantidad === 1 ? unidad : `${unidad}s`;
  const monto = montoCentavos === undefined ? '' : ` (${montoEnLempiras(montoCentavos)})`;
  return `${etiqueta}: ${cantidad} ${plural}${monto}`;
}

/**
 * El mensaje que se le manda al tesorero. Corto a proposito: se lee en un
 * telefono y de el sale un "SI" que verifica pagos de verdad.
 */
export function textoDelResumen(resumen: ResumenConciliacion, venceALas: string): string {
  return [
    linea('Extracto recibido', resumen.depositos, 'depósito', resumen.depositosCentavos),
    '',
    linea('Se verificarían', resumen.verificaria, 'pago', resumen.verificariaCentavos),
    linea('Sin comprobante', resumen.sinComprobante, 'depósito', resumen.sinComprobanteCentavos),
    linea('Sin depósito', resumen.sinDeposito, 'comprobante'),
    linea('A revisión', resumen.aRevision, 'pago'),
    '',
    `Respondé SI para aplicarlo. Vence a las ${venceALas}.`,
  ].join('\n');
}
