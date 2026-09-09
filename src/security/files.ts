import { createHash } from 'node:crypto';
import { env } from '@/src/config/env';

export const ALLOWED_RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export type AllowedReceiptMime = (typeof ALLOWED_RECEIPT_MIME_TYPES)[number];

export interface ValidatedReceiptFile {
  bytes: Buffer;
  mimeType: AllowedReceiptMime;
  sha256: string;
  size: number;
}

function sniffMime(bytes: Buffer): AllowedReceiptMime | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  return undefined;
}

export function validateReceiptFile(input: Uint8Array, declaredMime: string | undefined): ValidatedReceiptFile {
  const bytes = Buffer.from(input);
  if (!bytes.length) throw new Error('empty_receipt_file');
  if (bytes.length > env().MAX_RECEIPT_BYTES) throw new Error('receipt_file_too_large');

  const detected = sniffMime(bytes);
  if (!detected) throw new Error('unsupported_receipt_file');
  if (!ALLOWED_RECEIPT_MIME_TYPES.includes(declaredMime as AllowedReceiptMime)) throw new Error('unsupported_receipt_mime');
  if (declaredMime !== detected) throw new Error('receipt_mime_mismatch');

  return {
    bytes,
    mimeType: detected,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
