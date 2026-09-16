/**
 * Repositorio de datos sobre Turso (docs/PLAN.md, fase 0).
 *
 * Las garantias fuertes las da el esquema, no este archivo: `mensajes` tiene el
 * message_id como clave primaria, `pagos.movimiento_id` es UNIQUE, `recibos`
 * usa AUTOINCREMENT y `pago_meses` tiene el indice parcial `ux_mes_activo`.
 * Aqui solo se agrupan las escrituras en transacciones para que nada quede a
 * medias, y se deja un evento por cada cambio (invariante 8).
 *
 * Fase 0 no conecta el webhook ni el procesador: eso es fase 1.
 */
import type { Client, Transaction } from '@libsql/client';

type Executor = Pick<Client, 'execute'>;
/** Un cliente abre transaccion propia; una transaccion en curso se reutiliza. */
export type Db = Client | Transaction;

export type EstadoMensaje = 'RECIBIDO' | 'PROCESANDO' | 'PROCESADO' | 'IGNORADO' | 'RECHAZADO' | 'ERROR';
export type EstadoVivienda = 'ACTIVA' | 'VACIA' | 'EXONERADA' | 'BAJA';
export type MetodoPago = 'TRANSFERENCIA' | 'EFECTIVO';
export type EstadoPago =
  | 'ESPERANDO_RESPUESTA' | 'PENDIENTE_VERIFICACION' | 'VERIFICADO' | 'EFECTIVO_COBRADO'
  | 'EN_REVISION' | 'NO_ENCONTRADO' | 'DUPLICADO' | 'RECHAZADO' | 'ANULADO';
export type EstadoMes = 'RESERVADO' | 'PAGADO' | 'LIBERADO';

export interface Evento {
  entidad: string;
  entidadId: string;
  accion: string;
  antes?: unknown;
  despues?: unknown;
  motivo?: string;
  actor: string;
}

export interface ViviendaInput {
  id: string;
  etapa: string;
  bloque: string;
  casa: string;
  estado: EstadoVivienda;
  fechaAlta: string;
}

export interface MensajeInput {
  messageId: string;
  telefono: string;
  tipo: string;
  mediaId?: string;
  /** Texto del mensaje; se borra al cerrarlo, igual que el media_id. */
  cuerpo?: string;
  estado: EstadoMensaje;
  recibidoEn: string;
}

export interface PagoInput {
  id: string;
  metodo: MetodoPago;
  montoCentavos: number;
  estado: EstadoPago;
  viviendaId?: string;
  messageId?: string;
  referencia?: string;
  telefonoContacto?: string;
  creadoEn: string;
}

export interface MesInput {
  periodo: string;
  montoCentavos: number;
}

export interface VerificacionInput {
  pagoId: string;
  movimientoId: string;
  verificadoPor: string;
  verificadoEn: string;
}

/**
 * El codigo compacto de la vivienda. Etapa, bloque y casa son texto y admiten
 * letras (`E1BAC18`), por eso se concatenan sin normalizar a numero.
 */
export function codigoVivienda(etapa: string, bloque: string, casa: string): string {
  return `E${etapa}B${bloque}C${casa}`;
}

/** Formato de presentacion del numero de recibo. */
export function formatoRecibo(numero: number): string {
  return `REC-${String(numero).padStart(6, '0')}`;
}

function esTransaccion(db: Db): db is Transaction {
  return 'commit' in db;
}

/**
 * Corre `fn` dentro de una transaccion. Si `db` ya es una transaccion la
 * reutiliza, para que fase 4 pueda emitir el recibo en la misma transaccion que
 * la verificacion sin duplicar codigo.
 */
export async function enTransaccion<T>(db: Db, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  if (esTransaccion(db)) return fn(db);

  const tx = await db.transaction('write');
  try {
    const resultado = await fn(tx);
    await tx.commit();
    return resultado;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/** Deja constancia de un cambio. `eventos` no se puede editar ni borrar. */
export async function registrarEvento(tx: Executor, evento: Evento, creadoEn: string): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO eventos (entidad, entidad_id, accion, antes_json, despues_json, motivo, actor, creado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      evento.entidad,
      evento.entidadId,
      evento.accion,
      evento.antes === undefined ? null : JSON.stringify(evento.antes),
      evento.despues === undefined ? null : JSON.stringify(evento.despues),
      evento.motivo ?? null,
      evento.actor,
      creadoEn,
    ],
  });
}

export async function crearVivienda(db: Db, vivienda: ViviendaInput, actor: string): Promise<void> {
  await enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO viviendas (id, etapa, bloque, casa, codigo, estado, fecha_alta)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        vivienda.id,
        vivienda.etapa,
        vivienda.bloque,
        vivienda.casa,
        codigoVivienda(vivienda.etapa, vivienda.bloque, vivienda.casa),
        vivienda.estado,
        vivienda.fechaAlta,
      ],
    });
    await registrarEvento(tx, {
      entidad: 'viviendas', entidadId: vivienda.id, accion: 'CREAR', despues: vivienda, actor,
    }, vivienda.fechaAlta);
  });
}

/**
 * Registra un mensaje entrante. Idempotente por `message_id`: un reintento de
 * Meta con el mismo id no crea un segundo registro (invariante 14).
 * Devuelve `true` solo la primera vez.
 */
export async function registrarMensaje(db: Db, mensaje: MensajeInput): Promise<boolean> {
  const resultado = await (db as Executor).execute({
    sql: `INSERT INTO mensajes (message_id, telefono, tipo, media_id, cuerpo, estado, recibido_en, actualizado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (message_id) DO NOTHING`,
    args: [
      mensaje.messageId,
      mensaje.telefono,
      mensaje.tipo,
      mensaje.mediaId ?? null,
      mensaje.cuerpo ?? null,
      mensaje.estado,
      mensaje.recibidoEn,
      mensaje.recibidoEn,
    ],
  });

  return resultado.rowsAffected > 0;
}

/** Borra el `media_id` una vez procesado el mensaje (invariante 11). */
export async function olvidarMedia(db: Db, messageId: string, actualizadoEn: string): Promise<void> {
  await (db as Executor).execute({
    sql: 'UPDATE mensajes SET media_id = NULL, actualizado_en = ? WHERE message_id = ?',
    args: [actualizadoEn, messageId],
  });
}

export async function crearPago(db: Db, pago: PagoInput, actor: string): Promise<void> {
  await enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO pagos (
              id, metodo, vivienda_id, monto_centavos, referencia, estado,
              telefono_contacto, message_id, creado_en, actualizado_en
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        pago.id,
        pago.metodo,
        pago.viviendaId ?? null,
        pago.montoCentavos,
        pago.referencia ?? null,
        pago.estado,
        pago.telefonoContacto ?? null,
        pago.messageId ?? null,
        pago.creadoEn,
        pago.creadoEn,
      ],
    });
    await registrarEvento(tx, {
      entidad: 'pagos', entidadId: pago.id, accion: 'CREAR', despues: { estado: pago.estado }, actor,
    }, pago.creadoEn);
  });
}

/**
 * Reserva los meses que cubre un pago. `ux_mes_activo` impide que dos pagos
 * tengan el mismo mes activo (RESERVADO o PAGADO) para una misma vivienda.
 */
export async function reservarMeses(
  db: Db,
  input: { pagoId: string; viviendaId: string; meses: readonly MesInput[]; actor: string; creadoEn: string },
): Promise<void> {
  await enTransaccion(db, async (tx) => {
    for (const mes of input.meses) {
      await tx.execute({
        sql: `INSERT INTO pago_meses (pago_id, vivienda_id, periodo, monto_centavos, estado)
              VALUES (?, ?, ?, ?, 'RESERVADO')`,
        args: [input.pagoId, input.viviendaId, mes.periodo, mes.montoCentavos],
      });
    }
    await registrarEvento(tx, {
      entidad: 'pagos',
      entidadId: input.pagoId,
      accion: 'RESERVAR_MESES',
      despues: { periodos: input.meses.map((mes) => mes.periodo) },
      actor: input.actor,
    }, input.creadoEn);
  });
}

/**
 * Libera los meses de un pago. Invariante 5: NO_ENCONTRADO, RECHAZADO y ANULADO
 * liberan el mes, y al salir del indice parcial el mes vuelve a quedar libre.
 */
export async function liberarMeses(
  db: Db,
  input: { pagoId: string; motivo: string; actor: string; creadoEn: string },
): Promise<void> {
  await enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: "UPDATE pago_meses SET estado = 'LIBERADO' WHERE pago_id = ?",
      args: [input.pagoId],
    });
    await registrarEvento(tx, {
      entidad: 'pagos',
      entidadId: input.pagoId,
      accion: 'LIBERAR_MESES',
      motivo: input.motivo,
      actor: input.actor,
    }, input.creadoEn);
  });
}

/**
 * Verifica una transferencia contra un movimiento del CSV del banco.
 * `pagos.movimiento_id` es UNIQUE, asi que un mismo movimiento no puede
 * verificar dos pagos (invariante 3).
 */
export async function verificarPagoConMovimiento(
  db: Db,
  input: VerificacionInput,
  actor: string,
): Promise<void> {
  await enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: `UPDATE pagos
            SET estado = 'VERIFICADO', movimiento_id = ?, verificado_por = ?, verificado_en = ?, actualizado_en = ?
            WHERE id = ?`,
      args: [input.movimientoId, input.verificadoPor, input.verificadoEn, input.verificadoEn, input.pagoId],
    });
    await tx.execute({
      sql: "UPDATE pago_meses SET estado = 'PAGADO' WHERE pago_id = ? AND estado = 'RESERVADO'",
      args: [input.pagoId],
    });
    await registrarEvento(tx, {
      entidad: 'pagos',
      entidadId: input.pagoId,
      accion: 'VERIFICAR',
      despues: { estado: 'VERIFICADO' },
      actor,
    }, input.verificadoEn);
  });
}

/**
 * Emite el recibo de un pago y devuelve su numero. La secuencia es global y
 * nunca se reutiliza, y `recibos.pago_id` es UNIQUE: un recibo por pago
 * (invariante 10).
 */
export async function emitirRecibo(
  db: Db,
  input: { pagoId: string; emitidoEn: string; actor: string },
): Promise<number> {
  return enTransaccion(db, async (tx) => {
    const resultado = await tx.execute({
      sql: "INSERT INTO recibos (pago_id, estado, emitido_en) VALUES (?, 'EMITIDO', ?)",
      args: [input.pagoId, input.emitidoEn],
    });

    const numero = Number(resultado.lastInsertRowid);
    await registrarEvento(tx, {
      entidad: 'recibos', entidadId: String(numero), accion: 'EMITIR', despues: { pagoId: input.pagoId }, actor: input.actor,
    }, input.emitidoEn);

    return numero;
  });
}

export interface MensajePendiente {
  messageId: string;
  telefono: string;
  tipo: string;
  mediaId: string | null;
  cuerpo: string | null;
  intentos: number;
  recibidoEn: string;
}

/**
 * Mensajes que el worker todavia tiene que procesar. `PROCESANDO` vuelve a la
 * lista porque una corrida cortada a la mitad deja el mensaje en ese estado y
 * nadie mas lo va a retomar. `limiteIntentos` evita reintentar para siempre.
 */
export async function mensajesPendientes(
  db: Db,
  limiteIntentos = 3,
  limite = 50,
): Promise<MensajePendiente[]> {
  const { rows } = await (db as Executor).execute({
    sql: `SELECT message_id, telefono, tipo, media_id, cuerpo, intentos, recibido_en
          FROM mensajes
          WHERE estado IN ('RECIBIDO','PROCESANDO') AND intentos < ?
          ORDER BY recibido_en
          LIMIT ?`,
    args: [limiteIntentos, limite],
  });

  return rows.map((row) => ({
    messageId: String(row.message_id),
    telefono: String(row.telefono),
    tipo: String(row.tipo),
    mediaId: row.media_id === null ? null : String(row.media_id),
    cuerpo: row.cuerpo === null ? null : String(row.cuerpo),
    intentos: Number(row.intentos),
    recibidoEn: String(row.recibido_en),
  }));
}

/**
 * Toma un mensaje para procesarlo y suma un intento. Devuelve `false` si otra
 * corrida ya lo termino, de modo que dos corridas simultaneas no lo procesan
 * dos veces.
 */
export async function tomarMensaje(db: Db, messageId: string, ahora: string): Promise<boolean> {
  const resultado = await (db as Executor).execute({
    sql: `UPDATE mensajes
          SET estado = 'PROCESANDO', intentos = intentos + 1, actualizado_en = ?
          WHERE message_id = ? AND estado IN ('RECIBIDO','PROCESANDO')`,
    args: [ahora, messageId],
  });

  return resultado.rowsAffected > 0;
}

/**
 * Cierra un mensaje. Al terminar se borra el `media_id`: la imagen no se guarda
 * y el identificador tampoco sobrevive al procesamiento (invariante 11).
 */
export async function cerrarMensaje(
  db: Db,
  input: { messageId: string; estado: EstadoMensaje; error?: string; actualizadoEn: string },
): Promise<void> {
  await (db as Executor).execute({
    sql: `UPDATE mensajes
          SET estado = ?, error = ?, media_id = NULL, cuerpo = NULL, actualizado_en = ?
          WHERE message_id = ?`,
    args: [input.estado, input.error ?? null, input.actualizadoEn, input.messageId],
  });
}
