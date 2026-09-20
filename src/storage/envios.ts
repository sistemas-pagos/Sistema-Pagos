import type { Client } from '@libsql/client';

/**
 * Los recibos que el vecino no recibio.
 *
 * Un pago verificado que no llega a avisarle a nadie es el peor estado posible
 * del sistema: la plata quedo contada, el tablero se ve perfecto y la persona
 * que pago no tiene nada. Hasta ahora eso no se veia en ningun lado — la fila
 * quedaba en `envios` y el unico que se enteraba era el vecino, reclamando.
 *
 * Son dos fallas distintas y conviene no confundirlas:
 *
 * - `FALLIDO`: se intento cinco veces y no entro. Es el caso del telefono mal
 *   escrito, o de la plantilla que Meta no aprobo como se esperaba.
 * - `PENDIENTE` sin moverse: la cola **no esta avanzando**. Si el workflow no
 *   corre (un secreto que falta, el cron apagado), los envios se quedan en
 *   PENDIENTE con cero intentos para siempre y nunca llegan a FALLIDO. Esta es
 *   la mas peligrosa justamente porque nada se mueve: sin este listado no hay
 *   ninguna senal de que algo ande mal.
 */

/**
 * Cuanto puede estar un envio en PENDIENTE antes de que sea una senal.
 *
 * El cron pide cada quince minutos, pero **no corre asi**. Medido sobre las
 * corridas reales de `enviar-recibos`, los huecos son de ~2 horas: el
 * `schedule` de GitHub Actions es best-effort y se retrasa cuando la cola de
 * runners esta cargada. Un umbral de una hora marcaria como atascado a todos
 * los envios normales, y una pantalla que siempre alarma no la mira nadie.
 *
 * Seis horas son unas tres corridas perdidas. Lo que de verdad responde rapido
 * es el encadenamiento con `Procesar comprobantes`, no el cron.
 */
export const MINUTOS_PARA_ATASCADO = 360;

export type MotivoNoEntregado = 'FALLIDO' | 'ATASCADO';

export interface ReciboNoEntregado {
  envioId: string;
  reciboNumero: number;
  vivienda: string;
  telefono: string;
  motivo: MotivoNoEntregado;
  intentos: number;
  error?: string;
  actualizadoEn: string;
}

/**
 * Los recibos emitidos que no llegaron.
 *
 * Un envio cuyo recibo fue ANULADO no entra: se anulo a proposito y se emitio
 * otro en su lugar, asi que el mensaje ya no corresponde (invariante 10). Es la
 * misma regla que aplica `enviosPendientes` para no mandarlo.
 */
export async function recibosNoEntregados(
  db: Client,
  ahora: Date = new Date(),
  minutosParaAtascado: number = MINUTOS_PARA_ATASCADO,
): Promise<ReciboNoEntregado[]> {
  const corte = new Date(ahora.getTime() - minutosParaAtascado * 60_000).toISOString();

  const { rows } = await db.execute({
    sql: `SELECT e.id, e.recibo_numero, e.telefono, e.estado, e.intentos, e.error, e.actualizado_en,
                 v.codigo AS vivienda
            FROM envios e
            JOIN recibos r ON r.numero = e.recibo_numero
            JOIN pagos p ON p.id = r.pago_id
            LEFT JOIN viviendas v ON v.id = p.vivienda_id
           WHERE r.estado = 'EMITIDO'
             AND (e.estado = 'FALLIDO'
                  OR (e.estado = 'PENDIENTE' AND e.actualizado_en < ?))
           ORDER BY e.actualizado_en, e.recibo_numero`,
    args: [corte],
  });

  return rows.map((row) => ({
    envioId: String(row.id),
    reciboNumero: Number(row.recibo_numero),
    vivienda: row.vivienda == null ? '—' : String(row.vivienda),
    telefono: String(row.telefono),
    motivo: String(row.estado) === 'FALLIDO' ? 'FALLIDO' : 'ATASCADO',
    intentos: Number(row.intentos),
    error: row.error == null ? undefined : String(row.error),
    actualizadoEn: String(row.actualizado_en),
  }));
}
