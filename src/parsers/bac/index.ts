import { parseHomeReference } from '@/src/domain/housing';
import type { ReceiptExtraction } from '@/src/domain/types';
import type { ReceiptParser } from '@/src/parsers/types';

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function linesOf(text: string): string[] {
  return text.replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function findLabel(lines: readonly string[], labels: readonly string[]): string | undefined {
  const normalizedLabels = labels.map((label) => stripDiacritics(label).toUpperCase());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = stripDiacritics(line).toUpperCase();
    for (const label of normalizedLabels) {
      if (normalized === label && lines[index + 1]) return lines[index + 1];
      if (normalized.startsWith(`${label}:`) || normalized.startsWith(`${label} `)) {
        const direct = line.match(/^.*?(?:[:\-])\s*(.+)$/);
        if (direct?.[1]) return direct[1].trim();
        const value = line.slice(label.length).replace(/^\s*[:\-]?\s*/, '').trim();
        if (value) return value;
      }
    }
  }
  return undefined;
}

function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.replace(/\s/g, '').match(/(?:HNL|LPS?\.?|L)?([\d.,]+)/i);
  if (!match) return undefined;
  let numeric = match[1];
  const lastComma = numeric.lastIndexOf(',');
  const lastDot = numeric.lastIndexOf('.');
  if (lastComma > lastDot) numeric = numeric.replace(/\./g, '').replace(',', '.');
  else numeric = numeric.replace(/,/g, '');
  const amount = Number.parseFloat(numeric);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function parseDate(value: string | undefined, text: string): string | undefined {
  const match = (value ?? text).match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!match) return undefined;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function parseTime(value: string | undefined, text: string): string | undefined {
  const match = (value ?? text).match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?\b/i);
  if (!match) return undefined;
  let hour = Number.parseInt(match[1], 10);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function normalizeReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.toUpperCase().match(/[A-Z0-9][A-Z0-9\-]{5,}/)?.[0];
}

function maskAccount(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : undefined;
}

function fallbackAmount(text: string): number | undefined {
  const values = Array.from(text.matchAll(/(?:HNL|LPS?\.?|L)\s*([\d.,]+)/gi))
    .map((match) => parseMoney(match[0]))
    .filter((value): value is number => value != null);
  return values.length ? Math.max(...values) : undefined;
}

export const bacParser: ReceiptParser = {
  id: 'bac-honduras',
  detect(text: string): number {
    const normalized = stripDiacritics(text).toUpperCase();
    let score = 0;
    if (/\bBAC\b/.test(normalized)) score += 0.6;
    if (/CREDOMATIC|BANCO DE AMERICA CENTRAL/.test(normalized)) score += 0.25;
    if (/REFERENCIA|TRANSACCION|BENEFICIARIO|CUENTA DESTINO/.test(normalized)) score += 0.15;
    return Math.min(1, score);
  },
  parse(text: string): ReceiptExtraction {
    const lines = linesOf(text);
    const amount = parseMoney(findLabel(lines, ['Monto', 'Monto transferido', 'Total', 'Importe'])) ?? fallbackAmount(text);
    const detail = findLabel(lines, ['Detalle', 'Descripción', 'Descripcion', 'Concepto', 'Motivo']);
    const home = parseHomeReference(detail) ?? parseHomeReference(text);
    const reference = normalizeReference(findLabel(lines, ['Referencia', 'No. de transacción', 'No de transaccion', 'Transacción', 'Transaccion', 'Número de confirmación', 'Numero de confirmacion']));
    const depositor = findLabel(lines, ['Depositante', 'Remitente', 'Ordenante', 'De', 'Nombre del ordenante']);
    const beneficiary = findLabel(lines, ['Beneficiario', 'A nombre de', 'Destino', 'Nombre beneficiario']);
    const destinationAccount = findLabel(lines, ['Cuenta destino', 'Cuenta beneficiaria', 'Cuenta de destino']);
    const warnings: string[] = [];
    if (!amount) warnings.push('amount_missing');
    if (!reference) warnings.push('reference_missing');
    if (!home) warnings.push('home_missing');
    const confidence = bacParser.detect(text) + (amount ? 0.1 : 0) + (reference ? 0.1 : 0) + (home ? 0.05 : 0);

    return {
      bank: 'BAC Honduras',
      depositor,
      transactionDate: parseDate(findLabel(lines, ['Fecha', 'Fecha de transacción', 'Fecha de transaccion']), text),
      transactionTime: parseTime(findLabel(lines, ['Hora', 'Hora de transacción', 'Hora de transaccion']), text),
      amount,
      detail,
      reference,
      beneficiary,
      destinationAccountMasked: maskAccount(destinationAccount),
      home,
      confidence: Math.min(1, confidence),
      rawText: text,
      warnings,
    };
  },
};
