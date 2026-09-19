import type { HomeRecord, PaymentRecord, PendingConversation, ProcessedMessage } from '@/src/domain/types';

/** Quien cambio un pago y por que. Va a `eventos`, que no se edita ni se borra. */
export interface CambioDePago {
  /**
   * `usuarios.id` cuando se sabe; si no, de donde vino el cambio: `panel`,
   * `whatsapp`, `extracto-bac`. Hoy el panel entra con una sola clave
   * compartida, asi que no hay persona que registrar — eso llega con el
   * usuario por persona de la fase 7.
   */
  actor: string;
  motivo?: string;
}

export interface PaymentStore {
  listPayments(): Promise<PaymentRecord[]>;
  getPayment(id: string): Promise<PaymentRecord | undefined>;
  savePayment(payment: PaymentRecord): Promise<void>;
  /**
   * Cambia el pago y deja constancia de quien y por que (invariante 8).
   *
   * `cambio` es obligatorio a proposito. Era opcional en la practica —no
   * existia— y el resultado fue que ni las acciones del panel ni la
   * conciliacion dejaban rastro: el motivo que una persona escribia al
   * rechazar un pago vivia en una columna que la siguiente verificacion
   * borraba. Lo que se puede olvidar, se olvida; el tipo lo pide ahora.
   */
  updatePayment(payment: PaymentRecord, cambio: CambioDePago): Promise<void>;
  /**
   * Guarda el pago verificado y emite su recibo **en la misma operacion**.
   *
   * Van juntos a proposito (docs/PLAN.md, fase 4). Si fueran dos pasos, un
   * fallo entre medio dejaria un pago verificado sin recibo: el vecino pago,
   * el sistema lo sabe, y nunca le llega nada. Nadie se entera, porque desde
   * el tablero ese pago se ve perfecto.
   *
   * Devuelve el numero del recibo, de una secuencia global que no se reutiliza
   * (invariante 10).
   */
  verifyPayment(payment: PaymentRecord, verifiedBy?: string): Promise<number>;

  listHomes(): Promise<HomeRecord[]>;
  saveHome(home: HomeRecord): Promise<void>;
  /** Validate the whole batch before writing so imports do not partially apply. */
  saveHomes(homes: readonly HomeRecord[]): Promise<void>;
  updateHome(home: HomeRecord): Promise<void>;

  getPendingByPhone(phone: string): Promise<PendingConversation | undefined>;
  savePending(pending: PendingConversation): Promise<void>;
  clearPending(phone: string): Promise<void>;

  hasProcessedMessage(messageId: string): Promise<boolean>;
  saveProcessedMessage(message: ProcessedMessage): Promise<void>;
}
