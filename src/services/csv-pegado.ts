/**
 * El CSV que una persona pega en el panel.
 *
 * Lo usan la importacion del padron y la de saldos iniciales. Vive aparte
 * porque es la misma rutina en los dos casos, y dos copias de un parser de CSV
 * con comillas terminan divergiendo justo en el caso raro: la fila que trae una
 * coma dentro de un valor entrecomillado.
 */

export class CsvPegadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvPegadoError';
  }
}

/** Sin tildes, sin espacios y en minuscula: `Fecha Alta` y `fecha_alta` son lo mismo. */
export function normalizarEncabezado(valor: string): string {
  return valor
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Tabulacion y punto y coma antes que la coma: quien exporta desde Excel en
 * español recibe punto y coma, y adivinarlo mal parte todas las filas.
 */
export function detectarDelimitador(encabezado: string): string {
  if (encabezado.includes('\t')) return '\t';
  if (encabezado.includes(';')) return ';';
  return ',';
}

/** Una fila, respetando las comillas dobles. */
export function partirLinea(linea: string, delimitador: string): string[] {
  const valores: string[] = [];
  let actual = '';
  let entreComillas = false;

  for (let indice = 0; indice < linea.length; indice += 1) {
    const caracter = linea[indice];
    if (caracter === '"') {
      if (entreComillas && linea[indice + 1] === '"') {
        actual += '"';
        indice += 1;
      } else {
        entreComillas = !entreComillas;
      }
      continue;
    }
    if (caracter === delimitador && !entreComillas) {
      valores.push(actual.trim());
      actual = '';
      continue;
    }
    actual += caracter;
  }

  if (entreComillas) throw new CsvPegadoError('Comillas sin cerrar en la importación.');
  valores.push(actual.trim());
  return valores;
}

/**
 * Un monto a centavos enteros (invariante 7).
 *
 * Se arma con enteros desde el texto y nunca con `parseFloat(...) * 100`, que
 * es la cuenta que convierte 150.15 en 15014.999999999998 y despues en 15014.
 *
 * Las tres formas se escriben explicitas en vez de ir quitando separadores uno
 * por uno: quitarlos a ciegas acepta `1.2.3` y lo guarda como L12.30, que es
 * peor que rechazarlo — un saldo mal tipeado que entra con otro valor no lo
 * nota nadie hasta que se cobra de mas.
 */
const CON_DECIMAL = /^(\d{1,3}(?:,\d{3})*|\d+)\.(\d{1,2})$/;
const CON_DECIMAL_EUROPEO = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{1,2})$/;
const SIN_DECIMAL = /^(\d{1,3}(?:[.,]\d{3})*|\d+)$/;

export function aCentavos(valor: string): number | undefined {
  const limpio = valor.replace(/\s/g, '').replace(/^L/i, '');
  if (!limpio) return undefined;

  const decimal = CON_DECIMAL.exec(limpio) ?? CON_DECIMAL_EUROPEO.exec(limpio);
  if (decimal) {
    const enteros = Number(decimal[1].replace(/[.,]/g, ''));
    return enteros * 100 + Number(decimal[2].padEnd(2, '0'));
  }

  const entero = SIN_DECIMAL.exec(limpio);
  return entero ? Number(entero[1].replace(/[.,]/g, '')) * 100 : undefined;
}
