type SafeLogValue = string | number | boolean | null | undefined;
type SafeLogFields = Record<string, SafeLogValue>;

function redact(value: string | undefined, visible = 4): string | undefined {
  if (!value) return undefined;
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(4, value.length - visible))}${value.slice(-visible)}`;
}

export function maskPhone(phone: string | undefined): string | undefined {
  return redact(phone?.replace(/\D/g, ''), 4);
}

export function maskReference(reference: string | undefined): string | undefined {
  return redact(reference?.trim(), 4);
}

export function maskIdentifier(identifier: string | undefined): string | undefined {
  return redact(identifier?.trim(), 6);
}

export function safeLog(level: 'info' | 'warn' | 'error', event: string, fields: SafeLogFields = {}): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });

  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.info(entry);
}
