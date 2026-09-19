import { type Db, enTransaccion, registrarEvento } from '@/src/storage/turso';

/**
 * Los ajustes de una vivienda (docs/PLAN.md, seccion 1 y fase 3).
 *
 * El caso que los trae es el saldo inicial: la deuda anterior a septiembre de
 * 2026 no se carga como meses ni como pagos, porque hacerlo obligaria a
 * inventar en que mes cae cada lempira de una deuda que nadie desglosó. Entra
 * una sola vez, como un numero por vivienda, y el mes a mes arranca limpio
 * desde el primer mes de servicio.
 *
 * `SALDO_INICIAL` entra una sola vez por vivienda y lo garantiza el indice
 * `ux_saldo_inicial_por_vivienda` de la migracion 006, no este archivo. Los
 * otros tipos se repiten cuantas veces haga falta.
 */

export type TipoAjuste = 'SALDO_INICIAL' | 'SALDO_A_FAVOR' | 'DEVOLUCION' | 'AJUSTE';

export interface AjusteInput {
  id: string;
  viviendaId: string;
  tipo: TipoAjuste;
  /** Solo para los ajustes que corrigen un mes concreto. El saldo inicial no tiene. */
  periodo?: string;
  /** En centavos enteros (invariante 7). */
  montoCentavos: number;
  motivo: string;
  creadoPor: string;
}

export interface Ajuste extends AjusteInput {
  creadoEn: string;
}

export interface ResultadoDeCarga {
  registrados: number;
  /** Viviendas que ya tenian saldo inicial. Reimportar no las toca. */
  omitidos: number;
}

/**
 * Registra los ajustes en una sola transaccion: o entran todos o no entra
 * ninguno. Una carga a medias dejaria media lista de casas con deuda y la otra
 * media sin, y desde afuera las dos se ven igual.
 *
 * Un `SALDO_INICIAL` repetido no es un error que valga la pena hacer fallar: es
 * lo que pasa cuando alguien reimporta por las dudas. Se omite y se cuenta.
 */
export async function registrarAjustes(
  db: Db,
  ajustes: readonly AjusteInput[],
  actor: string,
  creadoEn: string,
): Promise<ResultadoDeCarga> {
  if (ajustes.length === 0) return { registrados: 0, omitidos: 0 };

  return enTransaccion(db, async (tx) => {
    let registrados = 0;

    for (const ajuste of ajustes) {
      const { rowsAffected } = await tx.execute({
        sql: `INSERT INTO ajustes (id, vivienda_id, tipo, periodo, monto_centavos, motivo, creado_por, creado_en)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT DO NOTHING`,
        args: [
          ajuste.id, ajuste.viviendaId, ajuste.tipo, ajuste.periodo ?? null,
          ajuste.montoCentavos, ajuste.motivo, ajuste.creadoPor, creadoEn,
        ],
      });

      if (rowsAffected === 0) continue;
      registrados += 1;

      // El evento dice el tipo y el monto, nunca de que casa es: `entidadId` es
      // el id del ajuste y el monto por vivienda no va a los logs, pero
      // `eventos` es la base y ahi si corresponde (invariante 8 y 12).
      await registrarEvento(tx, {
        entidad: 'ajustes', entidadId: ajuste.id, accion: 'CREAR',
        despues: { tipo: ajuste.tipo, montoCentavos: ajuste.montoCentavos, viviendaId: ajuste.viviendaId },
        motivo: ajuste.motivo, actor,
      }, creadoEn);
    }

    return { registrados, omitidos: ajustes.length - registrados };
  });
}

function aAjuste(fila: Record<string, unknown>): Ajuste {
  const periodo = fila.periodo == null ? undefined : String(fila.periodo);
  return {
    id: String(fila.id),
    viviendaId: String(fila.vivienda_id),
    tipo: String(fila.tipo) as TipoAjuste,
    ...(periodo ? { periodo } : {}),
    montoCentavos: Number(fila.monto_centavos),
    motivo: String(fila.motivo),
    creadoPor: String(fila.creado_por),
    creadoEn: String(fila.creado_en),
  };
}

export async function ajustesDeVivienda(db: Db, viviendaId: string): Promise<Ajuste[]> {
  const { rows } = await db.execute({
    sql: 'SELECT * FROM ajustes WHERE vivienda_id = ? ORDER BY creado_en, id',
    args: [viviendaId],
  });
  return rows.map((fila) => aAjuste(fila as unknown as Record<string, unknown>));
}

/** Las viviendas que ya tienen saldo inicial, para no volver a pedirlo. */
export async function viviendasConSaldoInicial(db: Db): Promise<Set<string>> {
  const { rows } = await db.execute("SELECT vivienda_id FROM ajustes WHERE tipo = 'SALDO_INICIAL'");
  return new Set(rows.map((fila) => String(fila.vivienda_id)));
}
