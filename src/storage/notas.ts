import type { Client } from '@libsql/client';
import { enTransaccion, registrarEvento } from './turso';

/**
 * Lo que el cobrador quiere decir sobre un pago que no puede tocar.
 *
 * El cobrador solo agrega cobros: no edita, no borra, no cambia referencias.
 * Cuando algo no cuadra, lo unico que puede hacer es dejarlo escrito para que
 * el admin decida. Eso es lo que hace que la separacion de permisos no lo
 * deje mudo.
 */
export interface NotaDePago {
  id: string;
  pagoId: string;
  autorId: string;
  texto: string;
  creadaEn: string;
}

export async function dejarNota(
  db: Client,
  nota: Omit<NotaDePago, 'creadaEn'> & { creadaEn: string },
): Promise<void> {
  const texto = nota.texto.trim();
  if (!texto) throw new Error('nota_vacia');

  await enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO notas_pago (id, pago_id, autor_id, texto, estado, creada_en)
            VALUES (?, ?, ?, ?, 'ABIERTA', ?)`,
      args: [nota.id, nota.pagoId, nota.autorId, texto.slice(0, 500), nota.creadaEn],
    });

    // El texto no va en el evento: puede nombrar al vecino (invariante 12).
    await registrarEvento(tx, {
      entidad: 'notas_pago', entidadId: nota.id, accion: 'CREAR',
      despues: { pagoId: nota.pagoId, estado: 'ABIERTA' }, actor: nota.autorId,
    }, nota.creadaEn);
  });
}

/**
 * Cierra la nota. No la borra ni la edita: queda con su texto, que es lo que
 * explica por que el pago quedo como quedo (invariante 8).
 */
export async function resolverNota(
  db: Client,
  input: { id: string; resueltaPor: string; en: string },
): Promise<boolean> {
  return enTransaccion(db, async (tx) => {
    const { rowsAffected } = await tx.execute({
      sql: `UPDATE notas_pago
               SET estado = 'RESUELTA', resuelta_por = ?, resuelta_en = ?
             WHERE id = ? AND estado = 'ABIERTA'`,
      args: [input.resueltaPor, input.en, input.id],
    });
    if (rowsAffected === 0) return false;

    await registrarEvento(tx, {
      entidad: 'notas_pago', entidadId: input.id, accion: 'RESOLVER',
      antes: { estado: 'ABIERTA' }, despues: { estado: 'RESUELTA' }, actor: input.resueltaPor,
    }, input.en);

    return true;
  });
}

export interface NotaAbierta extends NotaDePago {
  vivienda: string;
  estadoDelPago: string;
  montoCentavos: number;
}

/** La bandeja del admin: lo que espera una decision, mas viejo primero. */
export async function notasAbiertas(db: Client, limite = 50): Promise<NotaAbierta[]> {
  const { rows } = await db.execute({
    sql: `SELECT n.id, n.pago_id, n.autor_id, n.texto, n.creada_en,
                 p.estado, p.monto_centavos, v.codigo
            FROM notas_pago n
            JOIN pagos p ON p.id = n.pago_id
            LEFT JOIN viviendas v ON v.id = p.vivienda_id
           WHERE n.estado = 'ABIERTA'
           ORDER BY n.creada_en
           LIMIT ?`,
    args: [limite],
  });

  return rows.map((fila) => ({
    id: String(fila.id),
    pagoId: String(fila.pago_id),
    autorId: String(fila.autor_id),
    texto: String(fila.texto),
    creadaEn: String(fila.creada_en),
    vivienda: fila.codigo == null ? '—' : String(fila.codigo),
    estadoDelPago: String(fila.estado),
    montoCentavos: Number(fila.monto_centavos),
  }));
}
