import { describe, expect, it } from 'vitest';
import { normalizeOptionalPhone, normalizePhone, samePhone } from '@/src/domain/phone';

describe('phone normalization', () => {
  it('normalizes E.164-style and formatted values to the same digits', () => {
    expect(normalizePhone('+504 9999-9999')).toBe('50499999999');
    expect(samePhone('+50499999999', '504 9999 9999')).toBe(true);
  });

  it('keeps blank optional phones empty and rejects implausible values', () => {
    expect(normalizeOptionalPhone('   ')).toBeUndefined();
    expect(() => normalizePhone('123')).toThrow('invalid_phone');
  });
});
