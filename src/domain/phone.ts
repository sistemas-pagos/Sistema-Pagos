export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw new Error('invalid_phone');
  return digits;
}

export function normalizeOptionalPhone(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return normalizePhone(value);
}

export function samePhone(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    return normalizePhone(left) === normalizePhone(right);
  } catch {
    return false;
  }
}
