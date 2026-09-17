import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const ejecutar = promisify(execFile);

/**
 * Los scripts de `scripts/` corren en Actions, no en la aplicacion: no pasan por
 * el empaquetado de Next ni por el transformador de vitest. Por eso `lint`,
 * `typecheck`, `test` y `build` pueden estar los cuatro en verde mientras el
 * worker falla en cada corrida, que es justo lo que paso: importa modulos con el
 * alias `@/` y sin extension, y trae una propiedad de parametro en el
 * constructor. Nada de eso lo resuelve Node por si solo.
 *
 * Esta prueba los arranca con el mismo ejecutor que usa el workflow y sin
 * credenciales. El script tiene que llegar hasta la validacion del entorno: si
 * se queja de `PAGOS_TURSO_URL`, cargo todos sus modulos. Si en cambio aparece
 * un error de sintaxis o de resolucion, es que no llego ni a empezar.
 */
const RUNNER = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');

const SCRIPTS = ['scripts/migrate.ts', 'scripts/procesar-comprobantes.ts', 'scripts/enviar-recibos.ts'];

/** Sin las credenciales, para que el script se detenga en la primera validacion. */
const ENTORNO_SIN_CREDENCIALES = {
  ...process.env,
  APP_MODE: 'production',
  PAGOS_TURSO_URL: '',
  PAGOS_TURSO_TOKEN: '',
};

async function arrancar(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await ejecutar(RUNNER, [script], {
      env: ENTORNO_SIN_CREDENCIALES,
      timeout: 60_000,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    // Salir con codigo distinto de cero es lo esperado: falta el entorno.
    const fallo = error as { stdout?: string; stderr?: string; message?: string };
    return `${fallo.stdout ?? ''}${fallo.stderr ?? ''}${fallo.message ?? ''}`;
  }
}

describe('los scripts de Actions arrancan', () => {
  it('el workflow los ejecuta con el mismo runner que esta prueba', async () => {
    const workflows = await Promise.all([
      fs.readFile('.github/workflows/migraciones.yml', 'utf8'),
      fs.readFile('.github/workflows/procesar-comprobantes.yml', 'utf8'),
      fs.readFile('.github/workflows/enviar-recibos.yml', 'utf8'),
    ]);

    // Si un workflow vuelve a `node script.ts`, la prueba deja de representar
    // lo que corre en produccion y hay que enterarse aca, no en la corrida.
    for (const workflow of workflows) {
      expect(workflow).toContain('npx tsx scripts/');
      expect(workflow).not.toMatch(/run: node .*scripts\//);
    }
  });

  it.each(SCRIPTS)('%s carga todos sus modulos', async (script) => {
    const salida = await arrancar(script);

    expect(salida).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    expect(salida).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(salida).not.toContain('SyntaxError');
    expect(salida).toContain('PAGOS_TURSO_URL');
  }, 60_000);
});
