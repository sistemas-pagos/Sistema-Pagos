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
