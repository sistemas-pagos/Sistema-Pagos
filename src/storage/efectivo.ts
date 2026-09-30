import type { Client } from '@libsql/client';
import { enTransaccion, registrarEvento } from './turso';

/**
 * El cobro en efectivo, de una sola pieza.
 *
 * A diferencia de una transferencia, el efectivo **no se verifica contra el
 * banco**: la invariante 2 dice que una casa esta pagada con
 * `EFECTIVO_COBRADO`, sin mas. El cobrador vio la plata. Por eso el pago, la
 * reserva de los meses, el recibo y su envio nacen juntos, en una transaccion:
 * un recibo sin pago seria un comprobante de nada, y un pago sin recibo
 * dejaria al vecino pagado y sin nada en la mano.
 *
 * El cierre de caja —que el cobrador entregue esa plata— es otro momento y
 * otra tabla. Registrar el cobro no dice que el dinero haya llegado a la
 * tesoreria.
 */
export interface CobroEnEfectivo {
  pagoId: string;
  viviendaId: string;
  /** Uno por mes. El monto de cada uno es la cuota vigente de ese mes. */
  meses: readonly { periodo: string; montoCentavos: number }[];
  cobradorId: string;
  telefono?: string;
  aceptaWhatsapp: boolean;
  fechaPago: string;
  plantilla: string;
  creadoEn: string;
}

export interface ResultadoCobro {
  /** El numero que el cobrador anota en su talonario. */
  reciboNumero: number;
  montoCentavos: number;
}

function totalDe(meses: CobroEnEfectivo['meses']): number {
  return meses.reduce((suma, mes) => suma + mes.montoCentavos, 0);
}

/**
 * Registra el cobro y devuelve el numero de recibo.
 *
 * Si alguno de los meses ya estaba tomado —la casa pago por transferencia
 * mientras el cobrador tocaba la puerta— la UNIQUE de `pago_meses` hace fallar
 * la transaccion entera y no queda nada a medias. Quien llama decide que hacer
 * con eso; `registrarCobroEnRevision` es el camino para cuando la plata ya se
 * recibio.
 */
export async function registrarCobroEnEfectivo(
  db: Client,
  cobro: CobroEnEfectivo,
  actor: string,
): Promise<ResultadoCobro> {
  if (cobro.meses.length === 0) throw new Error('cobro_sin_meses');
  const montoCentavos = totalDe(cobro.meses);
  if (montoCentavos <= 0) throw new Error('cobro_sin_monto');

  return enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO pagos (
              id, metodo, vivienda_id, monto_centavos, estado, fecha_pago,
              telefono_contacto, acepta_whatsapp, cobrador_id, creado_en, actualizado_en
            ) VALUES (?, 'EFECTIVO', ?, ?, 'EFECTIVO_COBRADO', ?, ?, ?, ?, ?, ?)`,
      args: [
        cobro.pagoId,
        cobro.viviendaId,
        montoCentavos,
        cobro.fechaPago,
        cobro.telefono ?? null,
        cobro.aceptaWhatsapp ? 1 : 0,
        cobro.cobradorId,
        cobro.creadoEn,
        cobro.creadoEn,
      ],
    });

    // PAGADO y no RESERVADO: con efectivo no hay nada mas que esperar.
    for (const mes of cobro.meses) {
      await tx.execute({
        sql: `INSERT INTO pago_meses (pago_id, vivienda_id, periodo, monto_centavos, estado)
              VALUES (?, ?, ?, ?, 'PAGADO')`,
        args: [cobro.pagoId, cobro.viviendaId, mes.periodo, mes.montoCentavos],
      });
    }

    const emitido = await tx.execute({
      sql: "INSERT INTO recibos (pago_id, estado, emitido_en) VALUES (?, 'EMITIDO', ?)",
      args: [cobro.pagoId, cobro.creadoEn],
    });
    const reciboNumero = Number(emitido.lastInsertRowid);

    // Sin telefono no hay a donde mandarlo, y sin consentimiento no se puede
    // (invariante 13). El pago vale igual: aparece en «recibos no entregados».
    if (cobro.telefono && cobro.aceptaWhatsapp) {
      await tx.execute({
        sql: `INSERT INTO envios (id, recibo_numero, telefono, plantilla, estado, actualizado_en)
              VALUES (?, ?, ?, ?, 'PENDIENTE', ?)`,
        args: [`env-${reciboNumero}`, reciboNumero, cobro.telefono, cobro.plantilla, cobro.creadoEn],
      });
    }

    // Ni telefono ni monto por casa en el evento (invariante 12): cuantos meses
    // y quien cobro alcanza para auditar.
    await registrarEvento(tx, {
      entidad: 'pagos',
      entidadId: cobro.pagoId,
      accion: 'COBRO_EFECTIVO',
      despues: { estado: 'EFECTIVO_COBRADO', meses: cobro.meses.length, recibo: reciboNumero },
      actor,
    }, cobro.creadoEn);

    return { reciboNumero, montoCentavos };
  });
}

/**
 * La plata que el cobrador ya recibio para una casa que resulta que ya pago.
 *
 * Se registra igual, y es deliberado: en la calle el cobrador **ya tiene el
 * dinero en la mano**. No anotarlo dejaria plata existiendo que el sistema no
 * conoce, que es peor que anotarla rara.
 *
 * No toma ningun mes —ya esta tomado— ni emite recibo, asi que **no hay numero
 * que anotar en el talonario** y al vecino no le llega ningun mensaje. Queda
 * para que el admin decida: devolver, dejarlo a cuenta del mes siguiente, o
 * anular el otro pago.
 */
export async function registrarCobroEnRevision(
  db: Client,
  cobro: Omit<CobroEnEfectivo, 'plantilla'> & { motivo: string },
  actor: string,
): Promise<{ montoCentavos: number }> {
  const montoCentavos = totalDe(cobro.meses);
  if (montoCentavos <= 0) throw new Error('cobro_sin_monto');

  return enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO pagos (
              id, metodo, vivienda_id, monto_centavos, estado, motivo_revision, fecha_pago,
              telefono_contacto, acepta_whatsapp, cobrador_id, creado_en, actualizado_en
            ) VALUES (?, 'EFECTIVO', ?, ?, 'EN_REVISION', ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        cobro.pagoId,
        cobro.viviendaId,
        montoCentavos,
        cobro.motivo.slice(0, 200),
        cobro.fechaPago,
        cobro.telefono ?? null,
        cobro.aceptaWhatsapp ? 1 : 0,
        cobro.cobradorId,
        cobro.creadoEn,
        cobro.creadoEn,
      ],
    });

    await registrarEvento(tx, {
      entidad: 'pagos',
      entidadId: cobro.pagoId,
      accion: 'COBRO_EFECTIVO_EN_REVISION',
      despues: { estado: 'EN_REVISION', meses: cobro.meses.length },
      actor,
    }, cobro.creadoEn);

    return { montoCentavos };
  });
}

/**
 * Lo que un cobrador lleva cobrado y todavia no entrego.
 *
 * **Incluye los cobros en revision**: esa plata tambien esta en su bolsillo, y
 * dejarla fuera del total le haria faltar dinero al cuadrar sin que nadie
 * entienda por que.
 */
export async function cobradoSinEntregar(
  db: Client,
  cobradorId: string,
): Promise<{ totalCentavos: number; cobros: number; enRevisionCentavos: number }> {
  const { rows } = await db.execute({
    sql: `SELECT estado, count(*) AS cuantos, coalesce(sum(monto_centavos), 0) AS monto
            FROM pagos
           WHERE metodo = 'EFECTIVO'
             AND cobrador_id = ?
             AND cierre_caja_id IS NULL
             AND estado IN ('EFECTIVO_COBRADO', 'VERIFICADO', 'EN_REVISION')
           GROUP BY estado`,
    args: [cobradorId],
  });

  let totalCentavos = 0;
  let cobros = 0;
  let enRevisionCentavos = 0;
  for (const fila of rows) {
    const monto = Number(fila.monto);
    totalCentavos += monto;
    cobros += Number(fila.cuantos);
    if (String(fila.estado) === 'EN_REVISION') enRevisionCentavos += monto;
  }

  return { totalCentavos, cobros, enRevisionCentavos };
}
