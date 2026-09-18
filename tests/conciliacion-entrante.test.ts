import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, nuevaBaseDePrueba } from './helpers/turso-test-db';
import { decidirConciliacion } from '@/src/services/conciliacion-entrante';
import { type Usuario, crearUsuario, puedeConciliar, sincronizarUsuario, usuarioPorTelefono } from '@/src/storage/usuarios';

/**
 * El extracto del banco llega por WhatsApp desde un numero autorizado, y de ese
 * mismo numero sale el "SI" que verifica pagos de verdad. Las reglas de aca son
 * las que deciden quien puede hacerlo.
 *
 * Los telefonos de estas pruebas son inventados: este repositorio es publico.
 */
const TELEFONO_TESORERO = '+504 9000-0001';
const TELEFONO_CUALQUIERA = '+50490000099';
const AHORA = '2026-09-16T12:00:00.000Z';

function usuario(overrides: Partial<Usuario> = {}): Usuario {
  return { id: 'u1', nombre: 'Tesorero', rol: 'TESORERO', activo: true, ...overrides };
}

describe('quien esta autorizado', () => {
  let db: Client;
  beforeEach(async () => { db = await nuevaBaseDePrueba(); });
  afterEach(() => { db.close(); });

  it('encuentra al tesorero por su telefono aunque venga con espacios y guiones', async () => {
    await crearUsuario(db, { id: 'u1', nombre: 'Tesorero', rol: 'TESORERO', telefono: TELEFONO_TESORERO }, ACTOR, AHORA);

    const encontrado = await usuarioPorTelefono(db, '50490000001');

    expect(encontrado).toMatchObject({ id: 'u1', rol: 'TESORERO' });
  });

  it('no encuentra a nadie con un numero que no esta', async () => {
    expect(await usuarioPorTelefono(db, TELEFONO_CUALQUIERA)).toBeUndefined();
  });

  /** Dar de baja tiene que cortar el acceso en el momento, sin desplegar nada. */
  it('no devuelve a un usuario dado de baja', async () => {
    await crearUsuario(db, { id: 'u1', nombre: 'Ex tesorero', rol: 'TESORERO', telefono: TELEFONO_TESORERO }, ACTOR, AHORA);
    await db.execute("UPDATE usuarios SET activo = 0 WHERE id = 'u1'");

    expect(await usuarioPorTelefono(db, TELEFONO_TESORERO)).toBeUndefined();
  });

  it('no se cae con un telefono que no es un telefono', async () => {
    expect(await usuarioPorTelefono(db, 'hola')).toBeUndefined();
  });

  /** El cobrador cobra efectivo; conciliar la cuenta seria darle la llave entera. */
  it('deja conciliar al tesorero y al admin, no al cobrador', () => {
    expect(puedeConciliar(usuario({ rol: 'TESORERO' }))).toBe(true);
    expect(puedeConciliar(usuario({ rol: 'ADMIN' }))).toBe(true);
    expect(puedeConciliar(usuario({ rol: 'COBRADOR' }))).toBe(false);
    expect(puedeConciliar(undefined)).toBe(false);
  });

  /** El alta queda registrada, pero el telefono no se escribe en el evento. */
  it('no guarda el telefono en el evento del alta', async () => {
    await crearUsuario(db, { id: 'u1', nombre: 'Tesorero', rol: 'TESORERO', telefono: TELEFONO_TESORERO }, ACTOR, AHORA);

    const { rows } = await db.execute("SELECT despues_json FROM eventos WHERE entidad = 'usuarios'");
    expect(String(rows[0].despues_json)).not.toContain('9000');
    expect(JSON.parse(String(rows[0].despues_json))).toEqual({ rol: 'TESORERO', activo: true });
  });
});

describe('sincronizar el autorizado con el secreto', () => {
  let db: Client;
  beforeEach(async () => { db = await nuevaBaseDePrueba(); });
  afterEach(() => { db.close(); });

  const tesorero = { id: 'u-tesorero', nombre: 'u-tesorero', rol: 'TESORERO' as const };

  it('crea la fila la primera vez', async () => {
    expect(await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA)).toBe('creado');
    expect(await usuarioPorTelefono(db, TELEFONO_TESORERO)).toMatchObject({ id: 'u-tesorero' });
  });

  /** Correrlo dos veces con el mismo secreto no puede cambiar nada. */
  it('no toca nada si ya esta asi', async () => {
    await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA);

    expect(await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA)).toBe('sin_cambios');
  });

  /**
   * Cambiar de tesorero es cambiar el secreto y volver a correr esto. Si en vez
   * de actualizar se creara una fila nueva quedarian **dos numeros
   * autorizados** a la vez, que es justo lo contrario de lo que se quiere.
   */
  it('cambia el telefono sin dejar autorizado al anterior', async () => {
    await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA);

    expect(await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_CUALQUIERA }, ACTOR, AHORA)).toBe('actualizado');

    expect(await usuarioPorTelefono(db, TELEFONO_CUALQUIERA)).toMatchObject({ id: 'u-tesorero' });
    expect(await usuarioPorTelefono(db, TELEFONO_TESORERO)).toBeUndefined();
    const { rows } = await db.execute('SELECT count(*) AS c FROM usuarios');
    expect(Number(rows[0].c)).toBe(1);
  });

  /** Correr la sincronizacion es decir "este es el autorizado". */
  it('reactiva a quien estaba dado de baja', async () => {
    await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA);
    await db.execute("UPDATE usuarios SET activo = 0 WHERE id = 'u-tesorero'");

    expect(await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA)).toBe('actualizado');
    expect(await usuarioPorTelefono(db, TELEFONO_TESORERO)).toBeDefined();
  });

  /**
   * Elegir solos cual gana seria quitarle el acceso a alguien sin que nadie lo
   * haya pedido.
   */
  it('se niega si ese telefono es de otra persona', async () => {
    await crearUsuario(db, { id: 'u-admin', nombre: 'Admin', rol: 'ADMIN', telefono: TELEFONO_TESORERO }, ACTOR, AHORA);

    await expect(sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA))
      .rejects.toThrow('u-admin');
  });

  it('el evento dice que el telefono cambio, pero no cual es', async () => {
    await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_TESORERO }, ACTOR, AHORA);
    await sincronizarUsuario(db, { ...tesorero, telefono: TELEFONO_CUALQUIERA }, ACTOR, AHORA);

    const { rows } = await db.execute("SELECT despues_json FROM eventos WHERE accion = 'ACTUALIZAR'");
    const despues = JSON.parse(String(rows[0].despues_json));
    expect(despues).toMatchObject({ telefonoCambio: true, rol: 'TESORERO', activo: true });
    expect(String(rows[0].despues_json)).not.toContain('9000');
  });
});

describe('la confirmacion', () => {
  it('acepta el SI como lo escribe la gente', () => {
    for (const texto of ['SI', 'si', 'Sí', 'sí.', ' SI ']) {
      expect(decidirConciliacion(usuario(), texto, true)).toEqual({ accion: 'confirmar' });
    }
  });

  it('acepta el NO para descartarlo', () => {
    expect(decidirConciliacion(usuario(), 'no', true)).toEqual({ accion: 'cancelar' });
  });

  /**
   * Aplicar verifica pagos y emite recibos. Un "si dale" o un "si pero
   * esperate" no son un si: se vuelve a preguntar, que cuesta un mensaje.
   */
  it('no adivina con una respuesta que no es exactamente SI o NO', () => {
    const resultado = decidirConciliacion(usuario(), 'si pero esperate', true);

    expect(resultado.accion).toBe('no_entendido');
    expect(resultado).toHaveProperty('respuesta', expect.stringContaining('SI'));
  });

  /** El tesorero tambien escribe por otras cosas. */
  it('un SI suelto sin nada esperando no hace nada', () => {
    expect(decidirConciliacion(usuario(), 'Si', false)).toEqual({ accion: 'nada' });
  });

  it('un SI de alguien que no es tesorero no hace nada', () => {
    expect(decidirConciliacion(undefined, 'Si', true)).toEqual({ accion: 'nada' });
  });
});
