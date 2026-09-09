import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { validateReceiptFile } from '@/src/security/files';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

afterEach(() => {
  delete process.env.MAX_RECEIPT_BYTES;
  resetEnvForTests();
});

describe('receipt file validation', () => {
  it('accepts PNG when MIME and magic bytes agree', () => {
    const result = validateReceiptFile(png, 'image/png');
    expect(result.mimeType).toBe('image/png');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects MIME spoofing', () => {
    expect(() => validateReceiptFile(png, 'image/jpeg')).toThrow('receipt_mime_mismatch');
  });

  it('rejects unsupported content even with an image MIME', () => {
    expect(() => validateReceiptFile(Buffer.from('not-an-image'), 'image/png')).toThrow('unsupported_receipt_file');
  });

  it('enforces the configured size limit', () => {
    process.env.MAX_RECEIPT_BYTES = '8';
    resetEnvForTests();
    expect(() => validateReceiptFile(png, 'image/png')).toThrow('receipt_file_too_large');
  });
});
