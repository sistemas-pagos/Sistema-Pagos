import type { Client, Row } from '@libsql/client';
import { env } from '@/src/config/env';
import type { HomeRecord, PaymentRecord, PaymentStatus, PendingConversation, ProcessedMessage } from '@/src/domain/types';
import { codigoVivienda } from '@/src/storage/turso';
import type { PaymentStore } from './types';

/**
 * El almacen sobre Turso, que reemplaza a Google Sheets como base
 * (docs/PLAN.md, seccion 1 y fase 7).
 *
 * No es un cambio de tecnologia: es lo que destraba los recibos. Los pagos
 * vivian en la hoja y el talonario de recibos en Turso, asi que emitir un
 * recibo era imposible — el pago no existia del lado donde esta el talonario.
 *
 * El dinero se guarda en centavos enteros (invariante 7). `PaymentRecord.amount`
 * viene en lempiras porque asi lo leen los servicios; la conversion pasa aca, en
 * el borde, y con enteros: `Math.round`, nunca `* 100` sobre un float ya
 * redondeado.
 */

function aCentavos(lempiras: number): number {
  return Math.round(lempiras * 100);
}

function aLempiras(centavos: number): number {
  return centavos / 100;
}

function texto(valor: unknown): string | undefined {
  if (valor === null || valor === undefined) return undefined;
  const cadena = String(valor);
  return cadena === '' ? undefined : cadena;
}

/**
 * La mascara es presentacion: lo que se guarda son los cuatro digitos, que es
 * lo que la invariante 4 compara. Se vuelve a armar al leer.
 */
const MASCARA = '••••';

function soloDigitos(valor: string | undefined): string | undefined {
  const digitos = valor?.replace(/\D/g, '');
  return digitos ? digitos.slice(-4) : undefined;
}

function conMascara(ultimos4: string | undefined): string | undefined {
  return ultimos4 ? `${MASCARA}${ultimos4}` : undefined;
}

function aPago(fila: Row): PaymentRecord {
  return {
    id: String(fila.id),
    createdAt: String(fila.creado_en),
    updatedAt: String(fila.actualizado_en),
    sourceMessageId: String(fila.message_id ?? ''),
    phone: String(fila.telefono_contacto ?? ''),
    bank: String(fila.banco ?? ''),
    depositor: texto(fila.depositante),
    transactionDate: texto(fila.fecha_pago),
    transactionTime: texto(fila.hora_pago),
    amount: aLempiras(Number(fila.monto_centavos)),
    detail: texto(fila.detalle),
    reference: texto(fila.referencia),
    beneficiary: texto(fila.beneficiario),
    destinationAccountMasked: conMascara(texto(fila.cuenta_ultimos4)),
    stage: texto(fila.etapa),
    block: texto(fila.bloque),
    house: texto(fila.casa),
    period: String(fila.periodo ?? ''),
    status: String(fila.estado) as PaymentStatus,
    fileHash: String(fila.archivo_sha256 ?? ''),
    duplicateOf: texto(fila.duplicado_de),
    duplicateReason: texto(fila.duplicado_motivo),
    reviewReason: texto(fila.motivo_revision),
    verificationSource: texto(fila.verificacion_origen),
    verifiedAt: texto(fila.verificado_en),
    bankMovementId: texto(fila.movimiento_id),
  };
}

/** El `JOIN` trae la vivienda porque el pago la guarda por id, no por E/B/C. */
const SELECT_PAGO = `
  SELECT p.*, v.etapa, v.bloque, v.casa
  FROM pagos p LEFT JOIN viviendas v ON v.id = p.vivienda_id`;

function aVivienda(fila: Row, cuotaPorDefecto: number): HomeRecord {
  return {
    id: String(fila.id),
    stage: String(fila.etapa),
    block: String(fila.bloque),
    house: String(fila.casa),
    responsible: texto(fila.responsable),
    monthlyFee: cuotaPorDefecto,
    active: String(fila.estado) === 'ACTIVA',
    startDate: texto(fila.fecha_alta),
    endDate: texto(fila.fecha_baja),
  };
}

export class TursoPaymentStore implements PaymentStore {
  constructor(private readonly db: Client) {}

  /**
   * La cuota sale de `cuotas` y no de cada vivienda: subirla no puede obligar a
   * editar casa por casa.
   *
   * Devuelve la vigente. La cuota **por periodo** —que un mes viejo se calcule
   * con la que regia entonces— es lo que falta, y solo se nota el dia que la
   * cuota cambie. Mientras `cuotas` este vacia se usa la del entorno.
   */
  private async cuotaVigente(): Promise<number> {
    const { rows } = await this.db.execute(
      'SELECT monto_centavos FROM cuotas ORDER BY vigente_desde DESC LIMIT 1',
    );
    const fila = rows[0];
    return fila ? aLempiras(Number(fila.monto_centavos)) : env().EXPECTED_PAYMENT_AMOUNT;
  }

  private async viviendaId(pago: PaymentRecord): Promise<string | null> {
    if (pago.stage == null || pago.block == null || pago.house == null) return null;
    const { rows } = await this.db.execute({
      sql: 'SELECT id FROM viviendas WHERE codigo = ?',
      args: [codigoVivienda(pago.stage, pago.block, pago.house)],
    });
    const fila = rows[0];
    if (!fila) throw new Error('home_not_found');
    return String(fila.id);
  }

  /**
   * Las veinte columnas que comparten el INSERT y el UPDATE, en ese orden. Cada
   * uno agrega despues lo suyo: no se mezclan, porque una columna corrida
   * escribe un dato valido en el lugar equivocado y eso no lo atrapa el tipo.
   */
  private argumentosDePago(pago: PaymentRecord, viviendaId: string | null): unknown[] {
    return [
      viviendaId,
      aCentavos(pago.amount),
      pago.transactionDate ?? null,
      pago.transactionTime ?? null,
      pago.bank || null,
      pago.reference ?? null,
      pago.depositor ?? null,
      pago.beneficiary ?? null,
      soloDigitos(pago.destinationAccountMasked) ?? null,
      pago.detail ?? null,
      pago.status,
      pago.period || null,
      pago.reviewReason ?? null,
      pago.phone || null,
      pago.fileHash || null,
      pago.duplicateOf ?? null,
      pago.duplicateReason ?? null,
      pago.verificationSource ?? null,
      pago.verifiedAt ?? null,
      pago.bankMovementId ?? null,
    ];
  }

  async listPayments(): Promise<PaymentRecord[]> {
    const { rows } = await this.db.execute(`${SELECT_PAGO} ORDER BY p.creado_en`);
    return rows.map(aPago);
  }

  async getPayment(id: string): Promise<PaymentRecord | undefined> {
    const { rows } = await this.db.execute({ sql: `${SELECT_PAGO} WHERE p.id = ?`, args: [id] });
    const fila = rows[0];
    return fila ? aPago(fila) : undefined;
  }

  async savePayment(pago: PaymentRecord): Promise<void> {
    const existente = await this.db.execute({ sql: 'SELECT 1 FROM pagos WHERE id = ?', args: [pago.id] });
    if (existente.rows.length > 0) throw new Error('payment_already_exists');

    await this.db.execute({
      sql: `INSERT INTO pagos (
              id, metodo, vivienda_id, monto_centavos, fecha_pago, hora_pago, banco, referencia,
              depositante, beneficiario, cuenta_ultimos4, detalle, estado, periodo, motivo_revision,
              telefono_contacto, archivo_sha256, duplicado_de, duplicado_motivo, verificacion_origen,
              verificado_en, movimiento_id, message_id, creado_en, actualizado_en
            ) VALUES (?, 'TRANSFERENCIA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        pago.id,
        ...this.argumentosDePago(pago, await this.viviendaId(pago)),
        pago.sourceMessageId || null,
        pago.createdAt,
        pago.updatedAt,
      ] as never[],
    });
  }

  async updatePayment(pago: PaymentRecord): Promise<void> {
    const resultado = await this.db.execute({
      sql: `UPDATE pagos SET
              vivienda_id = ?, monto_centavos = ?, fecha_pago = ?, hora_pago = ?, banco = ?,
              referencia = ?, depositante = ?, beneficiario = ?, cuenta_ultimos4 = ?, detalle = ?,
              estado = ?, periodo = ?, motivo_revision = ?, telefono_contacto = ?, archivo_sha256 = ?,
              duplicado_de = ?, duplicado_motivo = ?, verificacion_origen = ?, verificado_en = ?,
              movimiento_id = ?, actualizado_en = ?
            WHERE id = ?`,
      args: [...this.argumentosDePago(pago, await this.viviendaId(pago)), pago.updatedAt, pago.id] as never[],
    });
    if (resultado.rowsAffected === 0) throw new Error('payment_not_found');
  }

  async listHomes(): Promise<HomeRecord[]> {
    const cuota = await this.cuotaVigente();
    const { rows } = await this.db.execute('SELECT * FROM viviendas ORDER BY codigo');
    return rows.map((fila) => aVivienda(fila, cuota));
  }

  async saveHome(home: HomeRecord): Promise<void> {
    await this.saveHomes([home]);
  }

  /** Se valida el lote entero antes de escribir: una importacion no se aplica a medias. */
  async saveHomes(homes: readonly HomeRecord[]): Promise<void> {
    const codigos = homes.map((home) => codigoVivienda(home.stage, home.block, home.house));
    if (new Set(codigos).size !== codigos.length) throw new Error('home_address_already_exists');
    if (new Set(homes.map((home) => home.id)).size !== homes.length) throw new Error('home_already_exists');

    const tx = await this.db.transaction('write');
    try {
      for (const [indice, home] of homes.entries()) {
        const choque = await tx.execute({
          sql: 'SELECT id, codigo FROM viviendas WHERE id = ? OR codigo = ?',
          args: [home.id, codigos[indice]],
        });
        if (choque.rows.length > 0) {
          throw new Error(String(choque.rows[0].id) === home.id ? 'home_already_exists' : 'home_address_already_exists');
        }
        await tx.execute({
          sql: `INSERT INTO viviendas (id, etapa, bloque, casa, codigo, estado, responsable, fecha_alta, fecha_baja)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            home.id, home.stage, home.block, home.house, codigos[indice],
            home.active ? 'ACTIVA' : 'BAJA', home.responsible ?? null,
            home.startDate ?? new Date().toISOString().slice(0, 10), home.endDate ?? null,
          ],
        });
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  async updateHome(home: HomeRecord): Promise<void> {
    const codigo = codigoVivienda(home.stage, home.block, home.house);
    const ajeno = await this.db.execute({
      sql: 'SELECT 1 FROM viviendas WHERE codigo = ? AND id <> ?',
      args: [codigo, home.id],
    });
    if (ajeno.rows.length > 0) throw new Error('home_address_already_exists');

    // `VACIA` y `EXONERADA` no se pueden expresar en el modelo, y la seccion 7
    // del plan todavia no dice que hacer con ellas: se conservan en vez de
    // aplastarlas a BAJA.
    const actual = await this.db.execute({ sql: 'SELECT estado FROM viviendas WHERE id = ?', args: [home.id] });
    if (actual.rows.length === 0) throw new Error('home_not_found');
    const anterior = String(actual.rows[0].estado);
    const estado = home.active ? 'ACTIVA' : (anterior === 'ACTIVA' ? 'BAJA' : anterior);

    await this.db.execute({
      sql: `UPDATE viviendas SET etapa = ?, bloque = ?, casa = ?, codigo = ?, estado = ?,
              responsable = ?, fecha_alta = COALESCE(?, fecha_alta), fecha_baja = ? WHERE id = ?`,
      args: [
        home.stage, home.block, home.house, codigo, estado,
        home.responsible ?? null, home.startDate ?? null, home.endDate ?? null, home.id,
      ],
    });
  }

  async getPendingByPhone(phone: string): Promise<PendingConversation | undefined> {
    const { rows } = await this.db.execute({
      sql: `SELECT id, pago_id, telefono, intentos, expira_en, creado_en FROM contextos
            WHERE telefono = ? AND estado = 'ABIERTO' AND expira_en > ?`,
      args: [phone, new Date().toISOString()],
    });
    const fila = rows[0];
    if (!fila) return undefined;
    return {
      id: String(fila.id),
      phone: String(fila.telefono),
      paymentId: String(fila.pago_id),
      createdAt: String(fila.creado_en),
      expiresAt: String(fila.expira_en),
      attempts: Number(fila.intentos),
    };
  }

  async savePending(pending: PendingConversation): Promise<void> {
    const abierto = await this.getPendingByPhone(pending.phone);
    if (abierto && abierto.paymentId !== pending.paymentId) throw new Error('pending_context_conflict');

    await this.db.execute({
      sql: `INSERT INTO contextos (id, pago_id, telefono, intentos, estado, expira_en, creado_en)
            VALUES (?, ?, ?, ?, 'ABIERTO', ?, ?)
            ON CONFLICT (pago_id) DO UPDATE SET
              intentos = excluded.intentos, estado = 'ABIERTO', expira_en = excluded.expira_en`,
      args: [pending.id, pending.paymentId, pending.phone, pending.attempts, pending.expiresAt, pending.createdAt],
    });
  }

  /** Se cierra, no se borra: el contexto es parte de lo que paso con ese pago. */
  async clearPending(phone: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE contextos SET estado = 'RESUELTO' WHERE telefono = ? AND estado = 'ABIERTO'",
      args: [phone],
    });
  }

  async hasProcessedMessage(messageId: string): Promise<boolean> {
    const { rows } = await this.db.execute({
      sql: "SELECT 1 FROM mensajes WHERE message_id = ? AND estado IN ('PROCESADO','IGNORADO','RECHAZADO')",
      args: [messageId],
    });
    return rows.length > 0;
  }

  /**
   * El mensaje ya existe: lo inserto el webhook. Aca solo se cierra, y se
   * borran `media_id` y `cuerpo`, que viven lo que dura el procesamiento y nada
   * mas (invariante 11).
   */
  async saveProcessedMessage(message: ProcessedMessage): Promise<void> {
    const estado = { processed: 'PROCESADO', ignored: 'IGNORADO', rejected: 'RECHAZADO' }[message.outcome];
    const ahora = new Date().toISOString();
    const resultado = await this.db.execute({
      sql: 'UPDATE mensajes SET estado = ?, media_id = NULL, cuerpo = NULL, actualizado_en = ? WHERE message_id = ?',
      args: [estado, ahora, message.messageId],
    });
    if (resultado.rowsAffected > 0) return;

    await this.db.execute({
      sql: `INSERT INTO mensajes (message_id, telefono, tipo, estado, recibido_en, actualizado_en)
            VALUES (?, '', ?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING`,
      args: [message.messageId, message.kind, estado, message.receivedAt, ahora],
    });
  }
}
