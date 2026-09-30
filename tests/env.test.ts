import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LARGO_MINIMO_SECRETO, env, resetEnvForTests } from '@/src/config/env';

const VARIABLES = [
  'APP_MODE', 'APP_BASE_URL', 'MAX_RECEIPT_BYTES', 'PENDING_CONTEXT_MINUTES',
  'EXPECTED_PAYMENT_AMOUNT', 'WHATSAPP_GRAPH_VERSION', 'EXPECTED_ACCOUNT_LAST4',
  'PAGOS_TURSO_URL', 'ADMIN_ACCESS_KEY', 'AUTH_SESSION_SECRET',
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

  /**
   * La clave del panel y el secreto de sesion son lo unico que separa
   * produccion de cualquiera que pase. Una clave corta se adivina aunque haya
   * limite de intentos, asi que no se puede configurar: el arranque falla.
   */
  it('no acepta una clave de panel corta', () => {
    process.env.ADMIN_ACCESS_KEY = 'clave123';
    resetEnvForTests();

    expect(() => env()).toThrow();
  });

  it('no acepta un secreto de sesion corto', () => {
    process.env.AUTH_SESSION_SECRET = 'corto';
    resetEnvForTests();

    expect(() => env()).toThrow();
  });

  /** El mensaje nombra la variable, nunca su valor (invariante 12). */
  it('al rechazarla no repite la clave en el error', () => {
    process.env.ADMIN_ACCESS_KEY = 'clave-secreta-corta';
    resetEnvForTests();

    expect(() => env()).toThrow(/ADMIN_ACCESS_KEY/);
    try {
      env();
    } catch (error) {
      expect(String(error)).not.toContain('clave-secreta-corta');
    }
  });

  it('acepta una de largo suficiente', () => {
    process.env.ADMIN_ACCESS_KEY = 'x'.repeat(LARGO_MINIMO_SECRETO);
    resetEnvForTests();

    expect(env().ADMIN_ACCESS_KEY).toHaveLength(LARGO_MINIMO_SECRETO);
  });
});

/**
 * Lo que el repositorio pide que alguien configure.
 *
 * Una variable declarada es una promesa: quien monta produccion la va a buscar,
 * la va a crear y, si es una credencial, la va a tener que cuidar. Tres
 * `GOOGLE_*` vivieron en el contrato mucho despues de que el ultimo modulo que
 * hablaba con Google desapareciera, y la guia de produccion mandaba a crear una
 * cuenta de servicio para nada.
 *
 * Se lee el archivo como texto a proposito: una variable opcional que nadie
 * configuro no aparece en el objeto que devuelve `env()`, asi que mirar el
 * resultado no probaria nada.
 */
describe('el contrato de entorno no pide lo que no usa', () => {
  const contrato = readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8');

  it('no declara ninguna variable de Google', () => {
    expect(contrato).not.toMatch(/GOOGLE_/);
  });

  it('el proyecto no depende de googleapis', () => {
    const paquete = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const todas = { ...paquete.dependencies, ...paquete.devDependencies };
    expect(Object.keys(todas)).not.toContain('googleapis');
  });
});
