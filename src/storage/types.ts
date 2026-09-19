import type { HomeRecord, PaymentRecord, PendingConversation, ProcessedMessage } from '@/src/domain/types';

export interface PaymentStore {
  listPayments(): Promise<PaymentRecord[]>;
  getPayment(id: string): Promise<PaymentRecord | undefined>;
  savePayment(payment: PaymentRecord): Promise<void>;
  updatePayment(payment: PaymentRecord): Promise<void>;
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
