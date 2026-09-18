import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, CUOTA_CENTAVOS, contar, nuevaBaseDePrueba, sembrar } from './helpers/turso-test-db';
import {
  type ImportacionInput,
  cerrarImportacion,
  expirarImportaciones,
  importacionPendienteDe,
  registrarImportacion,
} from '@/src/storage/conciliacion';

const AHORA = '2026-09-16T12:00:00.000Z';
const VENCE = '2026-09-16T14:00:00.000Z';
const DESPUES = '2026-09-16T14:00:01.000Z';

let db: Client;

beforeEach(async () => { db = await nuevaBaseDePrueba(); await sembrar(db); });
afterEach(() => { db.close(); });

function importacion(overrides: Partial<ImportacionInput> = {}): ImportacionInput {
  return {
    id: 'imp2',
    subidoPor: 'u1',
    archivoSha256: 'sha-extracto-septiembre',
    movimientos: [
      { huella: 'huella-a', fecha: '2026-09-02', referencia: '412000001', montoCentavos: CUOTA_CENTAVOS },
      { huella: 'huella-b', fecha: '2026-09-03', referencia: '412000002', montoCentavos: CUOTA_CENTAVOS },
    ],
    resumen: { verificaria: 2 },
    expiraEn: VENCE,
    creadoEn: AHORA,
    ...overrides,
  };
}

describe('registrar la importacion', () => {
  it('guarda el extracto y sus movimientos sin aplicar nada', async () => {
    const resultado = await registrarImportacion(db, importacion(), ACTOR);

    expect(resultado).toMatchObject({ registrada: true, nuevos: 2, repetidos: 0 });
    const { rows } = await db.execute("SELECT estado FROM importaciones_csv WHERE id = 'imp2'");
    expect(rows[0].estado).toBe('PENDIENTE_CONFIRMACION');
  });

  /**
   * El tesorero reenvia el mismo archivo cuando no le llega la respuesta. Si
   * entrara dos veces habria dos confirmaciones vivas para lo mismo.
   */
  it('no deja entrar dos veces el mismo archivo', async () => {
    await registrarImportacion(db, importacion(), ACTOR);
    const segunda = await registrarImportacion(db, importacion({ id: 'imp3' }), ACTOR);

    expect(segunda.registrada).toBe(false);
    expect(await contar(db, 'importaciones_csv')).toBe(2); // la sembrada y la primera
  });

  /**
   * Dos descargas del banco se solapan casi siempre, asi que un movimiento
   * repetido es lo normal y no un error. Si entrara dos veces, la invariante 3
   * —un movimiento verifica un solo pago— se caeria sola.
   */
  it('no duplica un movimiento que ya trajo otra importacion', async () => {
    const resultado = await registrarImportacion(db, importacion({
      movimientos: [
        { huella: 'huella-mov1', fecha: '2026-09-05', referencia: 'REF-mov1', montoCentavos: CUOTA_CENTAVOS },
        { huella: 'huella-c', fecha: '2026-09-06', referencia: '412000003', montoCentavos: CUOTA_CENTAVOS },
      ],
    }), ACTOR);

    expect(resultado).toMatchObject({ nuevos: 1, repetidos: 1 });
    expect(await contar(db, 'movimientos_banco')).toBe(3);
  });

  /** El movimiento queda con la importacion que lo vio primero. */
  it('deja el movimiento repetido donde estaba', async () => {
    await registrarImportacion(db, importacion({
      movimientos: [{ huella: 'huella-mov1', fecha: '2026-09-05', montoCentavos: CUOTA_CENTAVOS }],
    }), ACTOR);

    const { rows } = await db.execute("SELECT importacion_id FROM movimientos_banco WHERE huella = 'huella-mov1'");
    expect(rows[0].importacion_id).toBe('imp1');
  });

  it('deja constancia en eventos', async () => {
    await registrarImportacion(db, importacion(), ACTOR);

    const { rows } = await db.execute("SELECT accion, actor FROM eventos WHERE entidad = 'importaciones_csv'");
    expect(rows[0]).toMatchObject({ accion: 'REGISTRAR', actor: ACTOR });
  });
});

describe('la confirmacion', () => {
  /**
   * Aplicar verifica pagos y emite recibos con numeros que no se reutilizan.
   * Dos "SI" seguidos llegan como dos corridas, asi que la carrera se corta en
   * la base y no en el codigo que lee los mensajes.
   */
  it('solo un SI aplica, aunque lleguen dos', async () => {
    await registrarImportacion(db, importacion(), ACTOR);

    const primera = await cerrarImportacion(db, 'imp2', 'APLICADA', ACTOR, AHORA);
    const segunda = await cerrarImportacion(db, 'imp2', 'APLICADA', ACTOR, AHORA);

    expect(primera).toBe(true);
    expect(segunda).toBe(false);
  });

  it('no aplica una confirmacion vencida', async () => {
    await registrarImportacion(db, importacion(), ACTOR);

    expect(await cerrarImportacion(db, 'imp2', 'APLICADA', ACTOR, DESPUES)).toBe(false);
    const { rows } = await db.execute("SELECT estado FROM importaciones_csv WHERE id = 'imp2'");
    expect(rows[0].estado).toBe('PENDIENTE_CONFIRMACION');
  });

  it('deja cancelar la que ya vencio', async () => {
    await registrarImportacion(db, importacion(), ACTOR);

    expect(await cerrarImportacion(db, 'imp2', 'CANCELADA', ACTOR, DESPUES)).toBe(true);
  });

  it('escribe el antes y el despues del cambio de estado', async () => {
    await registrarImportacion(db, importacion(), ACTOR);
    await cerrarImportacion(db, 'imp2', 'APLICADA', ACTOR, AHORA);

    const { rows } = await db.execute("SELECT antes_json, despues_json FROM eventos WHERE accion = 'CERRAR'");
    expect(JSON.parse(String(rows[0].antes_json))).toEqual({ estado: 'PENDIENTE_CONFIRMACION' });
    expect(JSON.parse(String(rows[0].despues_json))).toEqual({ estado: 'APLICADA' });
  });
});

describe('buscar la importacion que espera un SI', () => {
  it('devuelve la del usuario con su resumen', async () => {
    await registrarImportacion(db, importacion(), ACTOR);

    const pendiente = await importacionPendienteDe(db, 'u1', AHORA);

    expect(pendiente?.id).toBe('imp2');
    expect(pendiente?.resumen).toEqual({ verificaria: 2 });
  });

  it('no devuelve una vencida', async () => {
    await registrarImportacion(db, importacion(), ACTOR);

    expect(await importacionPendienteDe(db, 'u1', DESPUES)).toBeUndefined();
  });

  /** Nadie confirma lo que subio otro. */
  it('no devuelve la que subio otra persona', async () => {
    await db.execute("INSERT INTO usuarios (id, nombre, rol) VALUES ('u2', 'Otro', 'ADMIN')");
    await registrarImportacion(db, importacion(), ACTOR);

    expect(await importacionPendienteDe(db, 'u2', AHORA)).toBeUndefined();
  });
});

describe('vencer las que nadie contesto', () => {
  /**
   * Una importacion pendiente para siempre es un "SI" que un mes despues
   * aplica un extracto viejo contra pagos que ya cambiaron.
   */
  it('marca las vencidas y deja las que todavia esperan', async () => {
    await registrarImportacion(db, importacion(), ACTOR);
    await registrarImportacion(db, importacion({
      id: 'imp4', archivoSha256: 'sha-otro', expiraEn: '2026-09-20T00:00:00.000Z', movimientos: [],
    }), ACTOR);

    expect(await expirarImportaciones(db, DESPUES, ACTOR)).toBe(1);

    const { rows } = await db.execute('SELECT id, estado FROM importaciones_csv ORDER BY id');
    expect(rows.map((fila) => [fila.id, fila.estado])).toEqual([
      ['imp1', 'APLICADA'], ['imp2', 'EXPIRADA'], ['imp4', 'PENDIENTE_CONFIRMACION'],
    ]);
  });

  it('no toca las que ya se cerraron', async () => {
    await registrarImportacion(db, importacion(), ACTOR);
    await cerrarImportacion(db, 'imp2', 'APLICADA', ACTOR, AHORA);

    expect(await expirarImportaciones(db, DESPUES, ACTOR)).toBe(0);
  });

  it('deja constancia de por que se cerro', async () => {
    await registrarImportacion(db, importacion(), ACTOR);
    await expirarImportaciones(db, DESPUES, ACTOR);

    const { rows } = await db.execute("SELECT motivo FROM eventos WHERE accion = 'CERRAR'");
    expect(rows[0].motivo).toBe('sin_confirmacion');
  });
});
