import { createHash } from 'node:crypto';
import type { BankMovement } from '@/src/services/reconciliation';

/**
 * Lee el extracto de movimientos que el BAC deja descargar desde la banca en
 * linea. Es el unico origen con el que la invariante 3 permite verificar una
 * transferencia: el comprobante que manda el vecino dice lo que el vecino
 * quiso mandar, y el extracto dice lo que el banco recibio.
 *
 * El archivo no es un CSV de una sola tabla. Trae tres secciones pegadas, con
 * distinta cantidad de columnas cada una:
 *
 * 1. la cabecera de la cuenta (17 columnas), que dice a que cuenta pertenece;
 * 2. `Detalle de Estado Bancario` (7 columnas), los movimientos;
 * 3. los totales por codigo de transaccion (5 columnas).
 *
 * Abrirlo como una tabla sola da basura en las tres.
 */

/** El BAC lo descarga en Windows-1252, no en UTF-8. */
function decodificar(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export type MotivoExtractoInvalido =
  | 'archivo_vacio'
  | 'sin_cabecera_de_cuenta'
  | 'sin_detalle_de_movimientos'
  | 'fila_incompleta'
  | 'fecha_invalida'
  | 'monto_invalido'
  | 'movimientos_repetidos'
  | 'balance_no_cuadra';

/**
 * El motivo va en el codigo y no en el texto: el mensaje se puede escribir
 * para una persona sin que nadie tenga que leer una cadena para decidir.
 */
export class ExtractoInvalidoError extends Error {
  readonly motivo: MotivoExtractoInvalido;

  constructor(motivo: MotivoExtractoInvalido, detalle?: string) {
    super(detalle ? `${motivo}: ${detalle}` : motivo);
    this.name = 'ExtractoInvalidoError';
    this.motivo = motivo;
  }
}

export interface CuentaDelExtracto {
  numeroCliente: string;
  titular: string;
  /** Columna `Producto`: el numero de cuenta al que pertenece el extracto. */
  cuenta: string;
  moneda: string;
  saldoInicialCentavos: number;
}

export interface MovimientoDelExtracto {
  /** `YYYY-MM-DD`. */
  fecha: string;
  referencia: string;
  /** `TF`, `CP`, `D5`, `AT`, `KS`... Informativo: no se filtra por el. */
  codigo: string;
  /** El banco la recorta a treinta caracteres, asi que suele venir cortada. */
  descripcion: string;
  debitoCentavos: number;
  creditoCentavos: number;
  balanceCentavos: number;
  /** `hash(fila entera normalizada)`. Es el `huella` de `movimientos_banco`. */
  huella: string;
}

export interface Extracto {
  cuenta: CuentaDelExtracto;
  movimientos: MovimientoDelExtracto[];
}

/** Sin tildes, en mayusculas y con un solo espacio: para comparar encabezados. */
function normalizado(valor: string): string {
  return valor.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Separa una linea en campos respetando las comillas dobles. El BAC no entrecomilla
 * nada hoy, pero una descripcion con coma dejaria de alinear las columnas para
 * siempre y no se sabria hasta que pasara en produccion.
 */
function campos(linea: string): string[] {
  const salida: string[] = [];
  let actual = '';
  let entreComillas = false;
  for (let i = 0; i < linea.length; i += 1) {
    const caracter = linea[i];
    if (caracter === '"') {
      if (entreComillas && linea[i + 1] === '"') {
        actual += '"';
        i += 1;
      } else {
        entreComillas = !entreComillas;
      }
    } else if (caracter === ',' && !entreComillas) {
      salida.push(actual);
      actual = '';
    } else {
      actual += caracter;
    }
  }
  salida.push(actual);
  return salida;
}

const COLUMNAS_MOVIMIENTO = 7;

/**
 * Las tres primeras columnas y las tres ultimas son fijas; lo que sobra en el
 * medio es descripcion que traia comas sin entrecomillar.
 */
function columnasDelMovimiento(linea: string): string[] {
  const partes = campos(linea);
  if (partes.length < COLUMNAS_MOVIMIENTO) {
    throw new ExtractoInvalidoError('fila_incompleta', `${partes.length} columnas`);
  }
  if (partes.length === COLUMNAS_MOVIMIENTO) return partes;
  return [
    ...partes.slice(0, 3),
    partes.slice(3, partes.length - 3).join(','),
    ...partes.slice(partes.length - 3),
  ];
}

const MONTO = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * A centavos enteros (invariante 7) sin pasar por coma flotante: `parseFloat`
 * de un monto en lempiras y despues `* 100` es exactamente la cuenta que
 * produce 14999 donde deberia haber 15000.
 */
function aCentavos(valor: string): number {
  const encontrado = MONTO.exec(valor.trim());
  if (!encontrado) throw new ExtractoInvalidoError('monto_invalido');
  const [, signo, entero, decimales = ''] = encontrado;
  const centavos = Number(entero.replace(/,/g, '')) * 100 + Number(decimales.padEnd(2, '0'));
  return signo ? -centavos : centavos;
}

const FECHA = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function aFechaIso(valor: string): string {
  const encontrado = FECHA.exec(valor.trim());
  if (!encontrado) throw new ExtractoInvalidoError('fecha_invalida');
  const [, dia, mes, anio] = encontrado;
  const fecha = new Date(`${anio}-${mes}-${dia}T00:00:00.000Z`);
  if (Number.isNaN(fecha.getTime()) || fecha.getUTCDate() !== Number(dia) || fecha.getUTCMonth() + 1 !== Number(mes)) {
    throw new ExtractoInvalidoError('fecha_invalida');
  }
  return `${anio}-${mes}-${dia}`;
}

/**
 * La fila entera, no solo la referencia: en un mes real hay diez referencias
 * repetidas, porque las compras con tarjeta reinician su contador cada dia.
 * El balance corriente es lo que vuelve irrepetible a cada fila, y es estable
 * entre descargas, asi que dos exportaciones que se solapan dan la misma
 * huella para el mismo movimiento y la UNIQUE de `movimientos_banco` los une.
 */
function huellaDeFila(valores: readonly (string | number)[]): string {
  return createHash('sha256').update(valores.join('|'), 'utf8').digest('hex');
}

/** `archivo_sha256` de `importaciones_csv`: el mismo archivo no se importa dos veces. */
export function huellaDelArchivo(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const CABECERA_CUENTA = 'NUMERO DE CLIENTES';
const CABECERA_DETALLE = 'FECHA DE TRANSACCION';
const CABECERA_TOTALES = 'CODIGO TRANSACCION TOTALES';

export function leerExtractoBac(bytes: Buffer): Extracto {
  const lineas = decodificar(bytes).split(/\r?\n/);
  if (lineas.every((linea) => linea.trim() === '')) throw new ExtractoInvalidoError('archivo_vacio');

  const indiceCuenta = lineas.findIndex((linea) => normalizado(campos(linea)[0] ?? '') === CABECERA_CUENTA);
  const filaCuenta = indiceCuenta === -1 ? undefined : campos(lineas[indiceCuenta + 1] ?? '');
  if (!filaCuenta || filaCuenta.length < 5) throw new ExtractoInvalidoError('sin_cabecera_de_cuenta');

  const cuenta: CuentaDelExtracto = {
    numeroCliente: filaCuenta[0].trim(),
    titular: filaCuenta[1].trim(),
    cuenta: filaCuenta[2].trim(),
    moneda: filaCuenta[3].trim(),
    saldoInicialCentavos: aCentavos(filaCuenta[4]),
  };

  const indiceDetalle = lineas.findIndex((linea) => normalizado(campos(linea)[0] ?? '') === CABECERA_DETALLE);
  if (indiceDetalle === -1) throw new ExtractoInvalidoError('sin_detalle_de_movimientos');

  const movimientos: MovimientoDelExtracto[] = [];
  for (const linea of lineas.slice(indiceDetalle + 1)) {
    if (linea.trim() === '') continue;
    const primera = normalizado(campos(linea)[0] ?? '');
    if (primera === CABECERA_TOTALES) break;
    if (!FECHA.test(primera)) continue;

    const [fecha, referencia, codigo, descripcion, debito, credito, balance] = columnasDelMovimiento(linea);
    const movimiento: Omit<MovimientoDelExtracto, 'huella'> = {
      fecha: aFechaIso(fecha),
      referencia: referencia.trim(),
      codigo: codigo.trim().toUpperCase(),
      descripcion: descripcion.trim(),
      debitoCentavos: aCentavos(debito),
      creditoCentavos: aCentavos(credito),
      balanceCentavos: aCentavos(balance),
    };
    movimientos.push({
      ...movimiento,
      huella: huellaDeFila([
        movimiento.fecha, movimiento.referencia, movimiento.codigo, movimiento.descripcion,
        movimiento.debitoCentavos, movimiento.creditoCentavos, movimiento.balanceCentavos,
      ]),
    });
  }

  const huellas = new Set(movimientos.map((movimiento) => movimiento.huella));
  if (huellas.size !== movimientos.length) throw new ExtractoInvalidoError('movimientos_repetidos');

  comprobarBalanceCorriente(cuenta.saldoInicialCentavos, movimientos);

  return { cuenta, movimientos };
}

/**
 * El balance de cada fila es el saldo despues de esa transaccion, asi que el
 * archivo entero forma una cadena que arranca en el `Saldo Inicial` de la
 * cabecera. Cuadra al centavo en las sesenta y una filas del extracto real que
 * sirvio de modelo.
 *
 * Comprobarla es barato y ataja lo que ninguna otra validacion ve: una
 * descripcion con una coma sin entrecomillar corre las columnas una posicion y
 * el monto leido sigue siendo un numero valido, plausible y equivocado. Tambien
 * delata un archivo recortado o editado a mano antes de mandarlo, que es
 * exactamente por donde alguien haria pasar un deposito que no existio.
 */
function comprobarBalanceCorriente(saldoInicialCentavos: number, movimientos: readonly MovimientoDelExtracto[]): void {
  let saldo = saldoInicialCentavos;
  for (const movimiento of movimientos) {
    saldo = saldo - movimiento.debitoCentavos + movimiento.creditoCentavos;
    if (saldo !== movimiento.balanceCentavos) throw new ExtractoInvalidoError('balance_no_cuadra');
  }
}

/** Los ultimos cuatro digitos de la cuenta del extracto, para comprobar que es la de cobro. */
export function ultimos4DeLaCuenta(extracto: Extracto): string {
  return extracto.cuenta.cuenta.replace(/\D/g, '').slice(-4);
}

export const BANCO_BAC = 'BAC Honduras';

/**
 * Solo lo que entro a la cuenta. Se filtra por credito y no por codigo de
 * transaccion a proposito: un deposito en agente, uno en ventanilla y una
 * transferencia llegan con codigos distintos, y el dia que el banco agregue
 * uno nuevo un filtro por codigo dejaria de ver pagos sin avisar.
 */
export function depositosRecibidos(extracto: Extracto): BankMovement[] {
  return extracto.movimientos
    .filter((movimiento) => movimiento.creditoCentavos > 0)
    .map((movimiento) => ({
      id: movimiento.huella,
      bank: BANCO_BAC,
      reference: movimiento.referencia,
      amount: movimiento.creditoCentavos / 100,
      transactionDate: movimiento.fecha,
    }));
}
