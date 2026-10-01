import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ROLES_DEL_PANEL, ROLES_DE_COBROS } from '@/src/auth/guard';

/**
 * Poder entrar a una pantalla no sirve si no hay como llegar.
 *
 * El panel tenia cuatro botones y ninguno iba a `/cobros`. Un ADMIN entraba
 * —el rol se lo permite— pero solo si sabia escribir la direccion a mano, que
 * es exactamente lo que le paso a Eduardo. Y desde cobros no habia vuelta.
 *
 * Se lee el archivo como texto porque lo que falla es el enlace ausente, no
 * una funcion: no hay nada que invocar cuando el problema es que no existe.
 */
const panel = readFileSync(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');
const cobros = readFileSync(new URL('../app/cobros/page.tsx', import.meta.url), 'utf8');

describe('se puede ir de una pantalla a la otra', () => {
  it('el panel ofrece ir a cobrar en efectivo', () => {
    expect(panel).toContain('href="/cobros"');
  });

  it('cobros ofrece volver al panel', () => {
    expect(cobros).toContain('href="/admin"');
  });

  /**
   * Los dos enlaces van detras del rol que de verdad entra. Un TESORERO ve el
   * panel pero no cobros, y un COBRADOR al reves: ofrecerles el enlace que no
   * les corresponde es mandarlos a un redirect.
   */
  it('cada enlace va detras del rol que puede usarlo', () => {
    expect(panel).toContain('ROLES_DE_COBROS');
    expect(cobros).toContain('ROLES_DEL_PANEL');
  });

  /** Lo que hace que los dos enlaces no sean el mismo: ADMIN esta en ambos. */
  it('solo ADMIN esta en las dos listas', () => {
    const enAmbas = ROLES_DEL_PANEL.filter((rol) => ROLES_DE_COBROS.includes(rol));

    expect(enAmbas).toEqual(['ADMIN']);
  });
});
