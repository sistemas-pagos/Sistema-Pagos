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
