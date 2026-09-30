import type { Client } from '@libsql/client';
import { enTransaccion, registrarEvento } from './turso';

/**
 * El cierre de caja: el cobrador entrega, el tesorero recibe.
 *
 * Registrar el cobro es la mitad del ciclo. La otra mitad es que esa plata
 * llegue a la tesoreria, y sin eso el sistema solo sabe que el cobrador
 * **dijo** que cobro. Es el riesgo numero uno del efectivo.
 *
 * El esquema exige desde la 001 que `cobrador_id <> tesorero_id`: nadie
 * recibe lo que el mismo cobro. Esta funcion no lo comprueba en codigo a
 * proposito — lo hace la base, que es donde una regla no se puede olvidar.
 */
export interface CierreDeCaja {
  id: string;
  cobradorId: string;
  tesoreroId: string;
  montoEsperadoCentavos: number;
  montoEntregadoCentavos: number;
  creadoEn: string;
}

export interface ResultadoCierre {
  pagosCerrados: number;
  diferenciaCentavos: number;
}

/**
 * Cierra todo lo que el cobrador tenia pendiente de entregar.
 *
 * Los cobros pasan a `VERIFICADO` **sin emitir un recibo nuevo**: el vecino ya
 * tiene el suyo desde que pago, y un segundo numero para el mismo pago
 * romperia la invariante 10.
 *
 * Los cobros en revision se cierran tambien —esa plata se entrego igual— pero
 * **no cambian de estado**: siguen esperando la decision del admin. Cerrarlos
 * como verificados seria usar la entrega del dinero para resolver un problema
 * que no tiene nada que ver.
 *
 * La diferencia entre lo esperado y lo entregado se guarda y no se corrige:
 * un faltante que se tapa no es un faltante, es un dato perdido.
 */
export async function cerrarCaja(
  db: Client,
  cierre: CierreDeCaja,
  actor: string,
): Promise<ResultadoCierre> {
  return enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO cierres_caja (
              id, cobrador_id, tesorero_id, monto_esperado_centavos, monto_entregado_centavos, creado_en
            ) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        cierre.id,
        cierre.cobradorId,
        cierre.tesoreroId,
        cierre.montoEsperadoCentavos,
        cierre.montoEntregadoCentavos,
        cierre.creadoEn,
      ],
    });

    // Los buenos quedan verificados; los que estan en revision se marcan como
    // entregados pero conservan su estado.
    const verificados = await tx.execute({
      sql: `UPDATE pagos
               SET estado = 'VERIFICADO', cierre_caja_id = ?, actualizado_en = ?
             WHERE metodo = 'EFECTIVO'
               AND cobrador_id = ?
               AND cierre_caja_id IS NULL
               AND estado = 'EFECTIVO_COBRADO'`,
      args: [cierre.id, cierre.creadoEn, cierre.cobradorId],
    });

    const enRevision = await tx.execute({
      sql: `UPDATE pagos
               SET cierre_caja_id = ?, actualizado_en = ?
             WHERE metodo = 'EFECTIVO'
               AND cobrador_id = ?
               AND cierre_caja_id IS NULL
               AND estado = 'EN_REVISION'`,
      args: [cierre.id, cierre.creadoEn, cierre.cobradorId],
    });

    const pagosCerrados = verificados.rowsAffected + enRevision.rowsAffected;
    const diferenciaCentavos = cierre.montoEntregadoCentavos - cierre.montoEsperadoCentavos;

    // Sin montos por casa ni nombres: cuantos pagos y si cuadro (invariante 12).
    await registrarEvento(tx, {
      entidad: 'cierres_caja', entidadId: cierre.id, accion: 'CERRAR',
      despues: { pagos: pagosCerrados, cuadra: diferenciaCentavos === 0 }, actor,
    }, cierre.creadoEn);

    return { pagosCerrados, diferenciaCentavos };
  });
}

export interface CajaPendiente {
  cobradorId: string;
  nombre: string;
  totalCentavos: number;
  cobros: number;
  enRevisionCentavos: number;
  /** El cobro mas viejo sin entregar. Es lo que dice si hay que apurarse. */
  desde: string;
}

/**
 * Las cajas que estan sin entregar, la mas vieja primero.
 *
 * El orden no es decoracion: lo que mide el riesgo del efectivo es **cuanto
 * tiempo** lleva la plata en la calle, no cuanta es. Mil lempiras de ayer
 * preocupan menos que ciento cincuenta de hace tres semanas.
 */
export async function cajasPendientes(db: Client): Promise<CajaPendiente[]> {
  const { rows } = await db.execute(`
    SELECT p.cobrador_id, u.nombre,
           count(*) AS cobros,
           coalesce(sum(p.monto_centavos), 0) AS total,
           coalesce(sum(CASE WHEN p.estado = 'EN_REVISION' THEN p.monto_centavos ELSE 0 END), 0) AS revision,
           min(p.creado_en) AS desde
      FROM pagos p
      LEFT JOIN usuarios u ON u.id = p.cobrador_id
     WHERE p.metodo = 'EFECTIVO'
       AND p.cobrador_id IS NOT NULL
       AND p.cierre_caja_id IS NULL
       AND p.estado IN ('EFECTIVO_COBRADO', 'VERIFICADO', 'EN_REVISION')
     GROUP BY p.cobrador_id
     ORDER BY desde`);

  return rows.map((fila) => ({
    cobradorId: String(fila.cobrador_id),
    nombre: fila.nombre == null ? String(fila.cobrador_id) : String(fila.nombre),
    totalCentavos: Number(fila.total),
    cobros: Number(fila.cobros),
    enRevisionCentavos: Number(fila.revision),
    desde: String(fila.desde),
  }));
}

export interface CobroSinEntregar {
  pagoId: string;
  vivienda: string;
  estado: string;
  montoCentavos: number;
  fechaPago: string;
  reciboNumero?: number;
}

/**
 * El detalle de lo que un cobrador lleva encima, para la hoja de entrega.
 *
 * Lleva el numero de recibo porque es lo que el cobrador tiene anotado en su
 * talonario: contra eso compara el tesorero, papel contra pantalla. Los cobros
 * en revision no tienen numero y aparecen igual — esa plata tambien se entrega.
 */
export async function cobrosSinEntregar(db: Client, cobradorId: string): Promise<CobroSinEntregar[]> {
  const { rows } = await db.execute({
    sql: `SELECT p.id, p.estado, p.monto_centavos, p.fecha_pago, v.codigo, r.numero
            FROM pagos p
            LEFT JOIN viviendas v ON v.id = p.vivienda_id
            LEFT JOIN recibos r ON r.pago_id = p.id AND r.estado = 'EMITIDO'
           WHERE p.metodo = 'EFECTIVO'
             AND p.cobrador_id = ?
             AND p.cierre_caja_id IS NULL
             AND p.estado IN ('EFECTIVO_COBRADO', 'VERIFICADO', 'EN_REVISION')
           ORDER BY p.creado_en`,
    args: [cobradorId],
  });

  return rows.map((fila) => ({
    pagoId: String(fila.id),
    vivienda: fila.codigo == null ? '—' : String(fila.codigo),
    estado: String(fila.estado),
    montoCentavos: Number(fila.monto_centavos),
    fechaPago: fila.fecha_pago == null ? '' : String(fila.fecha_pago),
    reciboNumero: fila.numero == null ? undefined : Number(fila.numero),
  }));
}
