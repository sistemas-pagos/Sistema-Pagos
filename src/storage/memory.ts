import type { HomeRecord, PaymentRecord, PendingConversation, ProcessedMessage } from '@/src/domain/types';
import type { PaymentStore } from './types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function homeAddress(home: Pick<HomeRecord, 'stage' | 'block' | 'house'>): string {
  return `${home.stage}:${home.block}:${home.house}`;
}

export class MemoryPaymentStore implements PaymentStore {
  private payments = new Map<string, PaymentRecord>();
  private homes = new Map<string, HomeRecord>();
  private pending = new Map<string, PendingConversation>();
  private messages = new Map<string, ProcessedMessage>();
  private readonly now: () => Date;

  constructor(
    seed?: { payments?: PaymentRecord[]; homes?: HomeRecord[]; pending?: PendingConversation[]; messages?: ProcessedMessage[] },
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
    seed?.payments?.forEach((record) => this.payments.set(record.id, clone(record)));
    seed?.homes?.forEach((record) => this.homes.set(record.id, clone(record)));
    seed?.pending?.forEach((record) => this.pending.set(record.phone, clone(record)));
    seed?.messages?.forEach((record) => this.messages.set(record.messageId, clone(record)));
  }

  async listPayments(): Promise<PaymentRecord[]> {
    return Array.from(this.payments.values(), clone);
  }

  async getPayment(id: string): Promise<PaymentRecord | undefined> {
    const record = this.payments.get(id);
    return record ? clone(record) : undefined;
  }

  async savePayment(payment: PaymentRecord): Promise<void> {
    if (this.payments.has(payment.id)) throw new Error('payment_already_exists');
    this.payments.set(payment.id, clone(payment));
  }

  async updatePayment(payment: PaymentRecord): Promise<void> {
    if (!this.payments.has(payment.id)) throw new Error('payment_not_found');
    this.payments.set(payment.id, clone(payment));
  }

  async listHomes(): Promise<HomeRecord[]> {
    return Array.from(this.homes.values(), clone);
  }

  async saveHome(home: HomeRecord): Promise<void> {
    await this.saveHomes([home]);
  }

  async saveHomes(homes: readonly HomeRecord[]): Promise<void> {
    const existingAddresses = new Set(Array.from(this.homes.values(), homeAddress));
    const batchIds = new Set<string>();
    const batchAddresses = new Set<string>();

    for (const home of homes) {
      if (this.homes.has(home.id) || batchIds.has(home.id)) throw new Error('home_already_exists');
      const address = homeAddress(home);
      if (existingAddresses.has(address) || batchAddresses.has(address)) throw new Error('home_address_already_exists');
      batchIds.add(home.id);
      batchAddresses.add(address);
    }

    homes.forEach((home) => this.homes.set(home.id, clone(home)));
  }

  async updateHome(home: HomeRecord): Promise<void> {
    if (!this.homes.has(home.id)) throw new Error('home_not_found');
    const duplicate = Array.from(this.homes.values()).some((item) => item.id !== home.id && item.stage === home.stage && item.block === home.block && item.house === home.house);
    if (duplicate) throw new Error('home_address_already_exists');
    this.homes.set(home.id, clone(home));
  }

  async getPendingByPhone(phone: string): Promise<PendingConversation | undefined> {
    const record = this.pending.get(phone);
    if (!record) return undefined;
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      this.pending.delete(phone);
      return undefined;
    }
    return clone(record);
  }

  async savePending(pending: PendingConversation): Promise<void> {
    const current = await this.getPendingByPhone(pending.phone);
    if (current && current.paymentId !== pending.paymentId) throw new Error('pending_context_conflict');
    this.pending.set(pending.phone, clone(pending));
  }

  async clearPending(phone: string): Promise<void> {
    this.pending.delete(phone);
  }

  async hasProcessedMessage(messageId: string): Promise<boolean> {
    return this.messages.has(messageId);
  }

  async saveProcessedMessage(message: ProcessedMessage): Promise<void> {
    this.messages.set(message.messageId, clone(message));
  }
}
