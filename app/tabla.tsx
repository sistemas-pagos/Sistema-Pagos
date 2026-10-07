import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

/**
 * Una tabla del panel que en el telefono deja de ser una tabla.
 *
 * Once columnas de datos de pago no entran en 390 px por mucho que se achique
 * la letra: lo que pasaba es que la fila se iba de lado y la columna «Estado»
 * —la que uno viene a mirar— quedaba fuera de la pantalla. Abajo de 720 px cada
 * fila se vuelve una tarjeta y cada celda una linea con su etiqueta.
 *
 * La etiqueta sale de `columnas`, el mismo arreglo con el que se dibuja el
 * `thead`. Escribirla a mano en cada `td` es la forma segura de que un dia diga
 * «Monto» sobre la fecha: la cabecera cambia y los cien `data-label` no.
 */
export function Tabla({
  columnas,
  className,
  children,
}: {
  columnas: readonly string[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `table-wrap ${className}` : 'table-wrap'}>
      <table>
        <thead>
          <tr>{columnas.map((columna) => <th key={columna}>{columna}</th>)}</tr>
        </thead>
        <tbody>{etiquetarFilas(children, columnas)}</tbody>
      </table>
    </div>
  );
}

/**
 * Le pone a cada celda el nombre de su columna.
 *
 * Se recorren solo los `tr` y sus `td` directos. Una celda que ya trae
 * `data-label` se respeta: la cabecera de la columna no siempre es lo que hay
 * que leer encima del dato cuando la celda trae un formulario.
 */
function etiquetarFilas(filas: ReactNode, columnas: readonly string[]): ReactNode {
  return Children.map(filas, (fila) => {
    if (!isValidElement(fila) || fila.type !== 'tr') return fila;

    const celdas = (fila.props as { children?: ReactNode }).children;
    let indice = 0;
    const etiquetadas = Children.map(celdas, (celda) => {
      if (!isValidElement(celda) || (celda.type !== 'td' && celda.type !== 'th')) return celda;

      const props = celda.props as { 'data-label'?: string; colSpan?: number };
      const columna = columnas[indice];
      const ancho = props.colSpan ?? 1;
      indice += ancho;
      // Una celda que cruza varias columnas no es ninguna de ellas: es la linea
      // de «no hay nada en este periodo». Etiquetarla con la primera ponia
      // «Fecha depósito» encima de esa frase.
      if (ancho > 1 || props['data-label'] !== undefined || columna === undefined) return celda;

      return cloneElement(celda, { 'data-label': columna } as Record<string, string>);
    });

    return cloneElement(fila, undefined, etiquetadas);
  });
}
