import type { ReceiptExtraction } from '@/src/domain/types';
import { bacParser } from './bac';
import type { ReceiptParser } from './types';

const PARSERS: readonly ReceiptParser[] = [bacParser];

export function detectAndParseReceipt(text: string): ReceiptExtraction {
  const candidates = PARSERS
    .map((parser) => ({ parser, score: parser.detect(text) }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < 0.5) throw new Error('unsupported_bank');
  return best.parser.parse(text);
}

export { bacParser } from './bac';
