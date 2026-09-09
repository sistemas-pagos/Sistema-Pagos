import type { ReceiptExtraction } from '@/src/domain/types';

export interface ReceiptParser {
  id: string;
  detect(text: string): number;
  parse(text: string): ReceiptExtraction;
}
