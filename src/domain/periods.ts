/**
 * Primer mes de servicio del sistema (docs/PLAN.md, seccion 1).
 *
 * La deuda anterior a septiembre de 2026 no se carga como meses: entra una sola
 * vez como `ajustes` de tipo SALDO_INICIAL. Por eso ningun pago se asigna a un
 * mes previo a este, y por eso ya no existe la regla especial de agosto.
 */
export const BASE_PERIOD = '2026-09';

/**
 * El mismo mes como fecha, para una vivienda que entra sin fecha de alta.
 *
 * Una casa que entra al padron sin fecha **ya estaba ahi**: el padron se carga
 * de un vecindario que existe. Sellarla con el dia de la carga haria que la
 * fecha en que alguien subio el archivo decidiera desde cuando debe cada casa.
 */
export const PRIMER_DIA_DE_SERVICIO = `${BASE_PERIOD}-01`;

const HONDURAS_TIME_ZONE = 'America/Tegucigalpa';

export function periodFromDate(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HONDURAS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('period_format_failed');
  return `${year}-${month}`;
}

export function isPeriod(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function shiftPeriod(period: string, monthDelta: number): string {
  if (!isPeriod(period) || !Number.isInteger(monthDelta)) throw new Error('invalid_period_shift');
  const [year, month] = period.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + monthDelta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function periodWindow(anchorPeriod: string, count = 4): string[] {
  if (!isPeriod(anchorPeriod) || !Number.isInteger(count) || count <= 0 || count > 24) {
    throw new Error('invalid_period_window');
  }
  return Array.from({ length: count }, (_, index) => shiftPeriod(anchorPeriod, -index));
}

export function periodLabel(period: string, locale: 'es' | 'en' = 'es'): string {
  if (!isPeriod(period)) return period;
  const [year, month] = period.split('-').map(Number);
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-HN', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}
