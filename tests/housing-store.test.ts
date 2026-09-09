import { describe, expect, it } from 'vitest';
import { MemoryPaymentStore } from '@/src/storage/memory';

describe('housing master store', () => {
  it('creates and updates homes while preserving unique stage+block+house', async () => {
    const store = new MemoryPaymentStore();
    await store.saveHome({ id: 'home-e1-b4-c18', stage: 1, block: 4, house: 18, monthlyFee: 150, active: true });
    expect((await store.listHomes()).length).toBe(1);

    await store.updateHome({ id: 'home-e1-b4-c18', stage: 1, block: 4, house: 18, responsible: 'Persona Demo', monthlyFee: 175, active: true });
    expect((await store.listHomes())[0].monthlyFee).toBe(175);

    await expect(store.saveHome({ id: 'another', stage: 1, block: 4, house: 18, monthlyFee: 150, active: true })).rejects.toThrow('home_address_already_exists');
    await expect(store.saveHome({ id: 'other-stage', stage: 2, block: 4, house: 18, monthlyFee: 150, active: true })).resolves.toBeUndefined();
  });
});
