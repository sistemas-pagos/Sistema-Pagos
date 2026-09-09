import type { HomeRecord, PaymentRecord, PendingConversation, ProcessedMessage } from '@/src/domain/types';

export interface PaymentStore {
  listPayments(): Promise<PaymentRecord[]>;
  getPayment(id: string): Promise<PaymentRecord | undefined>;
  savePayment(payment: PaymentRecord): Promise<void>;
  updatePayment(payment: PaymentRecord): Promise<void>;

  listHomes(): Promise<HomeRecord[]>;
  saveHome(home: HomeRecord): Promise<void>;
  updateHome(home: HomeRecord): Promise<void>;

  getPendingByPhone(phone: string): Promise<PendingConversation | undefined>;
  savePending(pending: PendingConversation): Promise<void>;
  clearPending(phone: string): Promise<void>;

  hasProcessedMessage(messageId: string): Promise<boolean>;
  saveProcessedMessage(message: ProcessedMessage): Promise<void>;
}
