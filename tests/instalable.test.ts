import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';

/**
 * El manifiesto que vuelve instalable la pagina de cobros.
 *
 * Lo que se cuida aca no es la estetica: es que `start_url` apunte a `/cobros`
 * y no a la raiz. Quien instala esto es el cobrador, y la raiz es la pagina
 * publica de demostracion — abrirle esa cada vez que toca el icono seria
 * inutil, y ademas le mostraria algo que no tiene nada que ver con su trabajo.
 */
describe('la app instalable', () => {
  const m = manifest();

  it('abre en la pantalla de cobros, no en la raiz', () => {
    expect(m.start_url).toBe('/cobros');
  });

  it('se abre sin la barra del navegador', () => {
    expect(m.display).toBe('standalone');
  });

  it('el fondo no parpadea en blanco al abrir', () => {
    // Si `background_color` fuera claro, el telefono pintaria una pantalla
    // blanca antes de cargar la interfaz oscura.
    expect(m.background_color).toBe('#08120f');
    expect(m.theme_color).toBe('#08120f');
  });

  it('trae un icono enmascarable, que es el que Android recorta', () => {
    const iconos = m.icons ?? [];
    expect(iconos.some((icono) => icono.purpose === 'maskable')).toBe(true);
    expect(iconos.every((icono) => icono.src.startsWith('/'))).toBe(true);
  });

  it('esta en espanol', () => {
    expect(m.lang).toBe('es');
  });
});
