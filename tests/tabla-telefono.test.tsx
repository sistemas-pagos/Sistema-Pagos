import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tabla } from '@/app/tabla';

/**
 * En el telefono la tabla deja de ser una tabla: cada fila es una tarjeta y
 * cada celda una linea con su etiqueta, que el CSS saca de `data-label`.
 *
 * Esa etiqueta es lo unico que dice que `L150.00` es la cuota y no el monto
 * recibido. Si se pierde, la pantalla no se rompe —se vuelve una lista de
 * numeros sin nombre—, y por eso se prueba aca y no mirando una captura.
 */
describe('la tabla se etiqueta sola', () => {
  const COLUMNAS = ['Vivienda', 'Cuota', 'Estado'];

  it('cada celda lleva el nombre de su columna', () => {
    const html = renderToStaticMarkup(
      <Tabla columnas={COLUMNAS}>
        <tr><td>E1-B4-C18</td><td>L150.00</td><td>Pendiente</td></tr>
      </Tabla>,
    );

    expect(html).toContain('data-label="Vivienda"');
    expect(html).toContain('data-label="Cuota"');
    expect(html).toContain('data-label="Estado"');
  });

  /** La cabecera y las etiquetas salen del mismo arreglo: no pueden discrepar. */
  it('la cabecera sale de las mismas columnas', () => {
    const html = renderToStaticMarkup(<Tabla columnas={COLUMNAS}><tr><td>x</td></tr></Tabla>);

    COLUMNAS.forEach((columna) => expect(html).toContain(`<th>${columna}</th>`));
  });

  /**
   * La linea de «no hay nada en este período» cruza toda la tabla. Etiquetarla
   * con la primera columna le ponia «Vivienda» encima de la frase.
   */
  it('la celda que cruza columnas no lleva etiqueta', () => {
    const html = renderToStaticMarkup(
      <Tabla columnas={COLUMNAS}>
        <tr><td colSpan={3}>No hay casos en revisión</td></tr>
      </Tabla>,
    );

    expect(html).not.toContain('data-label');
  });

  /** Las filas llegan como el resultado de un `.map()`, no una por una. */
  it('funciona con las filas generadas en lote', () => {
    const casas = ['E1-B4-C18', 'E1-B4-C19'];

    const html = renderToStaticMarkup(
      <Tabla columnas={COLUMNAS}>
        {casas.map((casa) => <tr key={casa}><td>{casa}</td><td>L150.00</td><td>Pendiente</td></tr>)}
      </Tabla>,
    );

    expect(html.match(/data-label="Vivienda"/g)).toHaveLength(2);
  });

  /** Y las celdas de una fila tambien pueden venir de un `.map()` anidado. */
  it('funciona con las celdas generadas en lote', () => {
    const html = renderToStaticMarkup(
      <Tabla columnas={['Vivienda', 'Enero', 'Febrero']}>
        <tr>
          <td>E1-B4-C18</td>
          {['Enero', 'Febrero'].map((mes) => <td key={mes}>Pagado</td>)}
        </tr>
      </Tabla>,
    );

    expect(html).toContain('data-label="Enero"');
    expect(html).toContain('data-label="Febrero"');
  });

  /** Una etiqueta puesta a mano gana: la cabecera no siempre es lo que hay que leer. */
  it('respeta la etiqueta que ya trae la celda', () => {
    const html = renderToStaticMarkup(
      <Tabla columnas={COLUMNAS}>
        <tr><td data-label="Casa">E1-B4-C18</td></tr>
      </Tabla>,
    );

    expect(html).toContain('data-label="Casa"');
    expect(html).not.toContain('data-label="Vivienda"');
  });
});

/*
 * Se leen los archivos como texto: lo que puede volver es un `<table>` escrito
 * a mano, y no hay nada que invocar cuando el problema es el que no usa el
 * componente.
 */
const PANTALLAS = [
  'app/admin/page.tsx',
  'app/admin/homes/page.tsx',
  'app/admin/homes/[stage]/[block]/[house]/page.tsx',
  'app/admin/recibos/page.tsx',
  'app/admin/caja/page.tsx',
  'app/admin/saldos/page.tsx',
];

describe('ninguna pantalla del panel escribe su propia tabla', () => {
  it.each(PANTALLAS)('%s usa Tabla', (archivo) => {
    const fuente = readFileSync(new URL(`../${archivo}`, import.meta.url), 'utf8');

    expect(fuente).toContain('<Tabla');
    expect(fuente).not.toContain('<table>');
  });
});
