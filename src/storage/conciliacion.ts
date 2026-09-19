import { BANCO_BAC } from '@/src/bank/bac-csv';
import type { BankMovement } from '@/src/services/reconciliation';
import { type Db, enTransaccion, registrarEvento } from '@/src/storage/turso';

/**
 * El ciclo de vida de una importacion de extracto: se registra, espera un "SI"
 * y se aplica o se vence.
 *
 * Aplicar verifica pagos de verdad y emite recibos con numeros que no se
 * reutilizan, asi que las dos cosas que este archivo tiene que garantizar son
 * que **el mismo archivo no entre dos veces** y que **un "SI" repetido no
 * aplique dos veces**. Las dos se resuelven en la base y no en el codigo que
 * lee los mensajes, porque ese codigo corre en varios workers a la vez.
 */

export type EstadoImportacion = 'PENDIENTE_CONFIRMACION' | 'APLICADA' | 'CANCELADA' | 'EXPIRADA';

export interface MovimientoImportado {
  /** Hash de la fila del extracto. Es tambien el `id` del movimiento. */
  huella: string;
  fecha: string;
  referencia?: string;
  descripcion?: string;
  montoCentavos: number;
}

export interface ImportacionInput {
  id: string;
  /** `usuarios.id` de quien mando el archivo. */
  subidoPor: string;
  archivoSha256: string;
  movimientos: readonly MovimientoImportado[];
  /** Se guarda tal cual en `resumen_json`: solo cuentas, nunca nombres. */
  resumen: unknown;
  expiraEn: string;
  creadoEn: string;
}

export interface ResultadoImportacion {
  /** `false` si ese archivo ya se habia subido antes. */
  registrada: boolean;
  /** Movimientos que la base no tenia. */
  nuevos: number;
  /** Movimientos que ya habia traido otra importacion anterior. */
  repetidos: number;
}

/**
 * Guarda la importacion y sus movimientos, sin aplicar nada todavia.
 *
 * Dos descargas seguidas del banco se solapan casi siempre, asi que los
 * movimientos repetidos son lo normal y no un error: los atrapa la UNIQUE de
 * `huella` y se cuentan aparte. El movimiento queda asociado a la importacion
 * que lo trajo primero, que es la que efectivamente lo vio.
 */
export async function registrarImportacion(
  db: Db,
  entrada: ImportacionInput,
  actor: string,
): Promise<ResultadoImportacion> {
  return enTransaccion(db, async (tx) => {
    const importacion = await tx.execute({
      sql: `INSERT INTO importaciones_csv (id, subido_por, archivo_sha256, estado, resumen_json, expira_en, creado_en)
            VALUES (?, ?, ?, 'PENDIENTE_CONFIRMACION', ?, ?, ?)
            ON CONFLICT (archivo_sha256) DO NOTHING`,
      args: [entrada.id, entrada.subidoPor, entrada.archivoSha256, JSON.stringify(entrada.resumen), entrada.expiraEn, entrada.creadoEn],
    });

    if (importacion.rowsAffected === 0) return { registrada: false, nuevos: 0, repetidos: 0 };

    let nuevos = 0;
    for (const movimiento of entrada.movimientos) {
      const fila = await tx.execute({
        sql: `INSERT OR IGNORE INTO movimientos_banco (id, importacion_id, fecha, referencia, descripcion, monto_centavos, huella)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          movimiento.huella, entrada.id, movimiento.fecha,
          movimiento.referencia ?? null, movimiento.descripcion ?? null,
          movimiento.montoCentavos, movimiento.huella,
        ],
      });
      nuevos += fila.rowsAffected;
    }

    await registrarEvento(tx, {
      entidad: 'importaciones_csv',
      entidadId: entrada.id,
      accion: 'REGISTRAR',
      despues: { estado: 'PENDIENTE_CONFIRMACION', movimientos: entrada.movimientos.length, nuevos },
      actor,
    }, entrada.creadoEn);

    return { registrada: true, nuevos, repetidos: entrada.movimientos.length - nuevos };
  });
}

/**
 * Todos los movimientos que la base conoce, no solo los de la ultima
 * importacion.
 *
 * Es a proposito: un comprobante puede corresponder a un deposito que llego en
 * un extracto anterior y entonces no tenia comprobante. Conciliar solo contra
 * el archivo recien subido lo dejaria sin verificar para siempre.
 */
export async function movimientosDeBanco(db: Db): Promise<BankMovement[]> {
  const { rows } = await db.execute(
    'SELECT id, fecha, referencia, monto_centavos FROM movimientos_banco ORDER BY fecha',
  );

  return rows.map((fila) => ({
    id: String(fila.id),
    bank: BANCO_BAC,
    reference: String(fila.referencia ?? ''),
    amount: Number(fila.monto_centavos) / 100,
    transactionDate: String(fila.fecha),
  }));
}

export interface ImportacionPendiente {
  id: string;
  subidoPor: string;
  resumen: unknown;
  expiraEn: string;
}

/**
 * La importacion que ese usuario dejo esperando confirmacion, si todavia no
 * vencio. Solo se mira la de quien manda el "SI": nadie confirma lo que subio
 * otro.
 */
export async function importacionPendienteDe(
  db: Db,
  usuarioId: string,
  ahora: string,
): Promise<ImportacionPendiente | undefined> {
  const { rows } = await db.execute({
    sql: `SELECT id, subido_por, resumen_json, expira_en FROM importaciones_csv
          WHERE subido_por = ? AND estado = 'PENDIENTE_CONFIRMACION' AND expira_en > ?
          ORDER BY creado_en DESC LIMIT 1`,
    args: [usuarioId, ahora],
  });

  const fila = rows[0];
  if (!fila) return undefined;
  return {
    id: String(fila.id),
    subidoPor: String(fila.subido_por),
    resumen: fila.resumen_json == null ? undefined : JSON.parse(String(fila.resumen_json)),
    expiraEn: String(fila.expira_en),
  };
}

/**
 * Cierra la importacion y devuelve `true` solo a quien la cerro.
 *
 * El cambio de estado es la carrera misma: dos "SI" seguidos llegan como dos
 * corridas, y el UPDATE condicionado al estado anterior deja pasar una sola.
 * Quien recibe `false` no aplica nada.
 */
export async function cerrarImportacion(
  db: Db,
  id: string,
  estado: Exclude<EstadoImportacion, 'PENDIENTE_CONFIRMACION'>,
  actor: string,
  ahora: string,
): Promise<boolean> {
  return enTransaccion(db, async (tx) => {
    const resultado = await tx.execute({
      sql: `UPDATE importaciones_csv SET estado = ?
            WHERE id = ? AND estado = 'PENDIENTE_CONFIRMACION'
              AND (? <> 'APLICADA' OR expira_en > ?)`,
      args: [estado, id, estado, ahora],
    });

    if (resultado.rowsAffected === 0) return false;

    await registrarEvento(tx, {
      entidad: 'importaciones_csv',
      entidadId: id,
      accion: 'CERRAR',
      antes: { estado: 'PENDIENTE_CONFIRMACION' },
      despues: { estado },
      actor,
    }, ahora);

    return true;
  });
}

/**
 * Vence las confirmaciones que nadie contesto. Lo corre `mantenimiento`: una
 * importacion pendiente para siempre es un "SI" que aplica un extracto de hace
 * un mes contra pagos que ya cambiaron.
 */
export async function expirarImportaciones(db: Db, ahora: string, actor: string): Promise<number> {
  return enTransaccion(db, async (tx) => {
    const { rows } = await tx.execute({
      sql: "SELECT id FROM importaciones_csv WHERE estado = 'PENDIENTE_CONFIRMACION' AND expira_en <= ?",
      args: [ahora],
    });

    for (const fila of rows) {
      const id = String(fila.id);
      await tx.execute({
        sql: "UPDATE importaciones_csv SET estado = 'EXPIRADA' WHERE id = ? AND estado = 'PENDIENTE_CONFIRMACION'",
        args: [id],
      });
      await registrarEvento(tx, {
        entidad: 'importaciones_csv', entidadId: id, accion: 'CERRAR',
        antes: { estado: 'PENDIENTE_CONFIRMACION' }, despues: { estado: 'EXPIRADA' },
        motivo: 'sin_confirmacion', actor,
      }, ahora);
    }

    return rows.length;
  });
}
