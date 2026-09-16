import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvForTests } from '@/src/config/env';

const VARIABLES = [
  'APP_MODE', 'APP_BASE_URL', 'MAX_RECEIPT_BYTES', 'PENDING_CONTEXT_MINUTES',
  'EXPECTED_PAYMENT_AMOUNT', 'WHATSAPP_GRAPH_VERSION', 'EXPECTED_ACCOUNT_LAST4',
  'PAGOS_TURSO_URL',
] as const;

afterEach(() => {
  for (const nombre of VARIABLES) delete process.env[nombre];
  resetEnvForTests();
});

describe('variables de entorno', () => {
  it('una variable declarada pero vacia se trata como ausente', () => {
    // Es lo que crea un panel de despliegue cuando uno deja el valor en blanco.
    for (const nombre of VARIABLES) process.env[nombre] = '';
    resetEnvForTests();

    const config = env();
    expect(config.APP_MODE).toBe('demo');
    expect(config.MAX_RECEIPT_BYTES).toBe(8 * 1024 * 1024);
    expect(config.PENDING_CONTEXT_MINUTES).toBe(30);
    expect(config.EXPECTED_PAYMENT_AMOUNT).toBe(150);
    expect(config.WHATSAPP_GRAPH_VERSION).toBe('v26.0');
    expect(config.APP_BASE_URL).toBeUndefined();
    expect(config.PAGOS_TURSO_URL).toBeUndefined();
  });

  it('un valor de solo espacios tambien cuenta como ausente', () => {
    process.env.APP_MODE = '   ';
    process.env.MAX_RECEIPT_BYTES = '  ';
    resetEnvForTests();

    expect(env().APP_MODE).toBe('demo');
    expect(env().MAX_RECEIPT_BYTES).toBe(8 * 1024 * 1024);
  });

  it('sigue leyendo los valores que si vienen configurados', () => {
    process.env.APP_MODE = 'production';
    process.env.MAX_RECEIPT_BYTES = '1024';
    resetEnvForTests();

    expect(env().APP_MODE).toBe('production');
    expect(env().MAX_RECEIPT_BYTES).toBe(1024);
  });

  it('un valor invalido sigue fallando', () => {
    process.env.MAX_RECEIPT_BYTES = '-5';
    resetEnvForTests();

    expect(() => env()).toThrow();
  });
});
