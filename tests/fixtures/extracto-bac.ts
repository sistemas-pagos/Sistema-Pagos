/**
 * El extracto de movimientos que el BAC deja descargar desde la banca en linea,
 * con la estructura calcada de un archivo real y **todos los valores
 * inventados**.
 *
 * Este repositorio es publico: ninguna cuenta, nombre, referencia o monto de
 * aqui corresponde a una persona. Lo que se conserva del original es solo la
 * forma, que es lo unico que el importador necesita acertar:
 *
 * - tres secciones en un mismo archivo (cabecera de la cuenta, detalle de
 *   movimientos, totales por codigo);
 * - separador `, ` con un espacio despues de cada coma y un espacio al final
 *   de cada linea;
 * - fin de linea CRLF y codificacion Windows-1252, no UTF-8;
 * - la descripcion recortada y rellenada a treinta caracteres exactos;
 * - fechas `dd/mm/aaaa` y montos con punto decimal, sin separador de miles;
 * - el balance de cada fila encadenado con el `Saldo Inicial` de la cabecera,
 *   que es por lo que aqui se calcula solo en vez de escribirse a mano.
 */

/** El banco recorta y rellena la descripcion a treinta caracteres. */
const ANCHO_DESCRIPCION = 30;

const SALDO_INICIAL_POR_DEFECTO = '1000.00';

export interface FilaExtracto {
  fecha: string;
  referencia: string;
  /** `TF`, `CP`, `D5`, `AT`, `KS`... El importador no filtra por este codigo. */
  codigo: string;
  descripcion: string;
  debito: string;
  credito: string;
  /** Solo para probar un archivo que no cuadra: normalmente se calcula. */
  balance?: string;
}

/** Depositos que entran a la cuenta de cobro, uno por cada forma de llegar. */
export const CREDITOS: FilaExtracto[] = [
  // Transferencia desde la app, de donde sale la mayoria.
  { fecha: '02/09/2026', referencia: '412000001', codigo: 'TF', descripcion: 'TEF DE:VECINA DE PRUEBA UNO', debito: '0.00', credito: '150.00' },
  // Deposito hecho en un agente bancario (pulperia).
  { fecha: '03/09/2026', referencia: '406000002', codigo: 'TF', descripcion: 'DEP.RAPIBAC 018925', debito: '0.00', credito: '150.00' },
  // Deposito en ventanilla. Otro codigo, y da igual: es un credito.
  { fecha: '04/09/2026', referencia: '412000003', codigo: 'D5', descripcion: 'DEPOSITO VECINO DE PRUEBA DOS', debito: '0.00', credito: '300.00' },
];

/** Compras y retiros del titular. Nunca son pagos del tren de aseo. */
export const DEBITOS: FilaExtracto[] = [
  { fecha: '05/09/2026', referencia: '000000004', codigo: 'CP', descripcion: 'SUPERMERCADO DE PRUEBA', debito: '250.00', credito: '0.00' },
  { fecha: '06/09/2026', referencia: '000000005', codigo: 'AT', descripcion: 'Retiro en ATM BAC 12', debito: '500.00', credito: '0.00' },
];

export const MOVIMIENTOS: FilaExtracto[] = [CREDITOS[0], CREDITOS[1], DEBITOS[0], CREDITOS[2], DEBITOS[1]];

/** En centavos, para encadenar el balance sin pasar por coma flotante. */
function centavos(valor: string): number {
  const [entero, decimales = ''] = valor.replace(/[",]/g, '').split('.');
  return Number(entero) * 100 + Number(decimales.padEnd(2, '0'));
}

function lempiras(valorEnCentavos: number): string {
  const signo = valorEnCentavos < 0 ? '-' : '';
  const absoluto = Math.abs(valorEnCentavos);
  return `${signo}${Math.floor(absoluto / 100)}.${String(absoluto % 100).padStart(2, '0')}`;
}

function fila(f: FilaExtracto, balance: string): string {
  const descripcion = f.descripcion.slice(0, ANCHO_DESCRIPCION).padEnd(ANCHO_DESCRIPCION, ' ');
  return `${f.fecha}, ${f.referencia}, ${f.codigo}, ${descripcion}, ${f.debito}, ${f.credito}, ${balance} `;
}

export interface OpcionesExtracto {
  /** `Producto` de la cabecera: la cuenta a la que pertenece el extracto. */
  cuenta?: string;
  titular?: string;
  /** Saldo antes del primer movimiento. Una descarga posterior arranca en otro. */
  saldoInicial?: string;
  movimientos?: FilaExtracto[];
  /** Deja fuera la seccion de totales, que algunas descargas no traen. */
  sinTotales?: boolean;
  /** Deja fuera el detalle entero, para probar el rechazo. */
  sinDetalle?: boolean;
}

/** El texto del extracto, antes de codificarlo. */
export function textoExtracto(opciones: OpcionesExtracto = {}): string {
  const movimientos = opciones.movimientos ?? MOVIMIENTOS;
  const saldoInicial = opciones.saldoInicial ?? SALDO_INICIAL_POR_DEFECTO;
  const lineas = [
    'Número de Clientes, Nombre, Producto, Moneda, Saldo Inicial, Saldo en Libros, Retenidos y Diferidos, Saldo Disponible, Fecha, STBGAV, STBUNC, Mensaje1, Mensaje2, Mensaje3, Mensaje4, Mensaje5, Mensaje6 ',
    `1234567, ${opciones.titular ?? 'TITULAR DE PRUEBA'}, ${opciones.cuenta ?? '790582920'}, HNL, ${saldoInicial}, 1150.00, 0.00, 1150.00, 16/09/2026, 1150.00, 0.00, , , , , ,  `,
    '',
    'Detalle de Estado Bancario',
  ];

  if (!opciones.sinDetalle) {
    let saldo = centavos(saldoInicial);
    lineas.push(
      'Fecha de Transacción, Referencia de Transacción, Código de Transacción, Descripción de Transacción, Débito de Transacción, Crédito de Transacción, Balance de Transacción ',
      ...movimientos.map((movimiento) => {
        saldo = saldo - centavos(movimiento.debito) + centavos(movimiento.credito);
        return fila(movimiento, movimiento.balance ?? lempiras(saldo));
      }),
    );
  }

  if (!opciones.sinTotales) {
    lineas.push(
      'Código Transacción Totales , Cantidad Débitos Totales, Montos Débitos Totales, Cantidad Créditos Totales, Montos Créditos Totales ',
      'TF, 0, 0.00, 2, 300.00 ',
      'CP, 1, 250.00, 0, 0.00 ',
    );
  }

  return lineas.join('\r\n');
}

/** El archivo tal como lo descarga el banco: Windows-1252, no UTF-8. */
export function extractoBac(opciones: OpcionesExtracto = {}): Buffer {
  return Buffer.from(textoExtracto(opciones), 'latin1');
}
