import { isValidHome } from '@/src/domain/housing';
import type { HomeRecord } from '@/src/domain/types';

const MAX_IMPORT_ROWS = 5_000;
const MAX_IMPORT_CHARS = 250_000;
const DEFAULT_MONTHLY_FEE = 150;

const HEADER_ALIASES: Record<string, keyof ImportRow> = {
  etapa: 'stage', stage: 'stage',
  bloque: 'block', block: 'block',
  casa: 'house', house: 'house',
  cuota: 'monthlyFee', cuota_mensual: 'monthlyFee', monthly_fee: 'monthlyFee', monthlyfee: 'monthlyFee',
  responsable: 'responsible', responsible: 'responsible', nombre: 'responsible', propietario: 'responsible',
  activa: 'active', activo: 'active', active: 'active',
  fecha_alta: 'startDate', start_date: 'startDate', startdate: 'startDate',
  fecha_baja: 'endDate', end_date: 'endDate', enddate: 'endDate',
};

interface ImportRow {
  stage?: string;
  block?: string;
  house?: string;
  monthlyFee?: string;
  responsible?: string;
  active?: string;
  startDate?: string;
  endDate?: string;
}

export class HomeImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HomeImportError';
  }
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function detectDelimiter(header: string): string {
  if (header.includes('\t')) return '\t';
  if (header.includes(';')) return ';';
  return ',';
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quoted) throw new HomeImportError('Comillas sin cerrar en la importación.');
  values.push(current.trim());
  return values;
}

function parseInteger(value: string | undefined, label: string, line: number): number {
  if (!value || !/^\d+$/.test(value.trim())) throw new HomeImportError(`Línea ${line}: ${label} inválido.`);
  return Number.parseInt(value, 10);
}

function parseFee(value: string | undefined, line: number): number {
  if (!value?.trim()) return DEFAULT_MONTHLY_FEE;
  const normalized = value.replace(/\s/g, '').replace(/^L/i, '').replace(/,/g, '');
  const fee = Number.parseFloat(normalized);
  if (!Number.isFinite(fee) || fee <= 0 || fee > 1_000_000) throw new HomeImportError(`Línea ${line}: cuota inválida.`);
  return fee;
}

function parseBoolean(value: string | undefined, line: number): boolean {
  if (!value?.trim()) return true;
  const normalized = normalizeHeader(value);
  if (['si', 'yes', 'true', '1', 'activa', 'activo'].includes(normalized)) return true;
  if (['no', 'false', '0', 'inactiva', 'inactivo'].includes(normalized)) return false;
  throw new HomeImportError(`Línea ${line}: valor de activa inválido.`);
}

function parseDate(value: string | undefined, label: string, line: number): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HomeImportError(`Línea ${line}: ${label} debe usar YYYY-MM-DD.`);
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new HomeImportError(`Línea ${line}: ${label} inválida.`);
  }
  return text;
}

function addressKey(stage: number, block: number, house: number): string {
  return `${stage}:${block}:${house}`;
}

export function parseHomesImport(input: string, existingHomes: readonly HomeRecord[] = []): HomeRecord[] {
  if (!input.trim()) throw new HomeImportError('La importación está vacía.');
  if (input.length > MAX_IMPORT_CHARS) throw new HomeImportError('La importación es demasiado grande.');

  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new HomeImportError('Incluye encabezados y al menos una vivienda.');
  if (lines.length - 1 > MAX_IMPORT_ROWS) throw new HomeImportError(`Máximo ${MAX_IMPORT_ROWS} viviendas por importación.`);

  const delimiter = detectDelimiter(lines[0]);
  const rawHeaders = parseDelimitedLine(lines[0], delimiter);
  const headers = rawHeaders.map((header) => {
    const normalized = normalizeHeader(header);
    const mapped = HEADER_ALIASES[normalized];
    if (!mapped) throw new HomeImportError(`Encabezado no reconocido: ${header}.`);
    return mapped;
  });
  if (new Set(headers).size !== headers.length) throw new HomeImportError('Hay encabezados duplicados o equivalentes.');
  for (const required of ['stage', 'block', 'house'] as const) {
    if (!headers.includes(required)) throw new HomeImportError(`Falta el encabezado obligatorio: ${required}.`);
  }

  const existingIds = new Set(existingHomes.map((home) => home.id));
  const existingAddresses = new Set(existingHomes.map((home) => addressKey(home.stage, home.block, home.house)));
  const importedIds = new Set<string>();
  const importedAddresses = new Set<string>();

  return lines.slice(1).map((line, rowIndex) => {
    const lineNumber = rowIndex + 2;
    const values = parseDelimitedLine(line, delimiter);
    if (values.length > headers.length && values.slice(headers.length).some((value) => value.trim())) {
      throw new HomeImportError(`Línea ${lineNumber}: tiene más columnas que los encabezados.`);
    }
    const row: ImportRow = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ''; });

    const stage = parseInteger(row.stage, 'etapa', lineNumber);
    const block = parseInteger(row.block, 'bloque', lineNumber);
    const house = parseInteger(row.house, 'casa', lineNumber);
    if (!isValidHome(stage, block, house)) throw new HomeImportError(`Línea ${lineNumber}: Etapa/Bloque/Casa fuera de rango.`);

    const startDate = parseDate(row.startDate, 'fecha_alta', lineNumber);
    const endDate = parseDate(row.endDate, 'fecha_baja', lineNumber);
    if (startDate && endDate && startDate > endDate) throw new HomeImportError(`Línea ${lineNumber}: fecha_baja es anterior a fecha_alta.`);

    const id = `home-e${stage}-b${block}-c${house}`;
    const address = addressKey(stage, block, house);
    if (existingIds.has(id) || existingAddresses.has(address)) throw new HomeImportError(`Línea ${lineNumber}: E${stage} B${block} C${house} ya existe.`);
    if (importedIds.has(id) || importedAddresses.has(address)) throw new HomeImportError(`Línea ${lineNumber}: E${stage} B${block} C${house} está duplicada en la importación.`);
    importedIds.add(id);
    importedAddresses.add(address);

    const responsible = row.responsible?.trim().slice(0, 160) || undefined;
    return {
      id,
      stage,
      block,
      house,
      responsible,
      monthlyFee: parseFee(row.monthlyFee, lineNumber),
      active: parseBoolean(row.active, lineNumber),
      startDate,
      endDate,
    };
  });
}
