import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, nuevaBaseDePrueba } from './helpers/turso-test-db';
import { decidirConciliacion } from '@/src/services/conciliacion-entrante';
import { type Usuario, crearUsuario, puedeConciliar, usuarioPorTelefono } from '@/src/storage/usuarios';

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

describe('un archivo que llega', () => {
  const csv = { kind: 'document' as const, filename: 'Transacciones_del_mes.csv', declaredMime: 'text/csv' };

  it('del tesorero, va a leerse como extracto', () => {
    expect(decidirConciliacion(usuario(), csv, false)).toEqual({ accion: 'extracto' });
  });

  /**
   * Fallar cerrado. Un extracto falso aplicado verifica pagos que nadie hizo,
   * asi que quien no esta autorizado ni siquiera llega a que se mire el
   * archivo — y tampoco se entera de que este camino existe.
   */
  it('de cualquier otro numero, ni se mira', () => {
    expect(decidirConciliacion(undefined, csv, false)).toEqual({ accion: 'nada' });
    expect(decidirConciliacion(usuario({ rol: 'COBRADOR' }), csv, false)).toEqual({ accion: 'nada' });
  });

  it('en Excel, pide que lo manden en CSV', () => {
    const resultado = decidirConciliacion(usuario(), { kind: 'document', filename: 'movimientos.xlsx' }, false);

    expect(resultado.accion).toBe('formato_no_soportado');
    expect(resultado).toHaveProperty('respuesta', expect.stringContaining('CSV'));
  });

  /** El tesorero tambien es vecino y puede mandar su propio comprobante. */
  it('en PDF, sigue por el camino de siempre', () => {
    expect(decidirConciliacion(usuario(), { kind: 'document', filename: 'comprobante.pdf' }, false))
      .toEqual({ accion: 'nada' });
  });

  it('una foto del tesorero es un comprobante, no un extracto', () => {
    expect(decidirConciliacion(usuario(), { kind: 'image' }, false)).toEqual({ accion: 'nada' });
  });

  /** WhatsApp a veces no manda el nombre del archivo. */
  it('sin nombre, se guia por el tipo declarado', () => {
    expect(decidirConciliacion(usuario(), { kind: 'document', declaredMime: 'text/comma-separated-values' }, false))
      .toEqual({ accion: 'extracto' });
  });
});

describe('la confirmacion', () => {
  const si = { kind: 'text' as const, body: 'Si' };

  it('acepta el SI como lo escribe la gente', () => {
    for (const texto of ['SI', 'si', 'Sí', 'sí.', ' SI ']) {
      expect(decidirConciliacion(usuario(), { kind: 'text', body: texto }, true)).toEqual({ accion: 'confirmar' });
    }
  });

  it('acepta el NO para descartarlo', () => {
    expect(decidirConciliacion(usuario(), { kind: 'text', body: 'no' }, true)).toEqual({ accion: 'cancelar' });
  });

  /**
   * Aplicar verifica pagos y emite recibos. Un "si dale" o un "si pero
   * esperate" no son un si: se vuelve a preguntar, que cuesta un mensaje.
   */
  it('no adivina con una respuesta que no es exactamente SI o NO', () => {
    const resultado = decidirConciliacion(usuario(), { kind: 'text', body: 'si pero esperate' }, true);

    expect(resultado.accion).toBe('no_entendido');
    expect(resultado).toHaveProperty('respuesta', expect.stringContaining('SI'));
  });

  /** El tesorero tambien escribe por otras cosas. */
  it('un SI suelto sin nada esperando no hace nada', () => {
    expect(decidirConciliacion(usuario(), si, false)).toEqual({ accion: 'nada' });
  });

  it('un SI de alguien que no es tesorero no hace nada', () => {
    expect(decidirConciliacion(undefined, si, true)).toEqual({ accion: 'nada' });
  });
});
