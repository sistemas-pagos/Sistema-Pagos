import { isValidHome, normalizeHomePart } from '@/src/domain/housing';
import type { HomeRecord } from '@/src/domain/types';
import { CsvPegadoError, aCentavos, detectarDelimitador, normalizarEncabezado, partirLinea } from '@/src/services/csv-pegado';
import type { AjusteInput } from '@/src/storage/ajustes';

/**
 * El saldo inicial de cada vivienda, pegado como CSV en el panel
 * (docs/PLAN.md, seccion 1 y fase 3).
 *
 * La deuda anterior al primer mes de servicio no se reparte en meses: entra una
 * sola vez, como un numero por casa. Repartirla obligaria a inventar en que mes
 * cae cada lempira de algo que nadie desglosó, y ese invento despues se cobra.
 *
 * Aqui no se escribe nada: se valida y se arma la lista. Quien la guarda decide
 * si entra entera o no entra (`registrarAjustes`).
 */

const MAX_FILAS = 5_000;
const MAX_CARACTERES = 250_000;
/** Un saldo inicial mayor que esto es un error de tipeo, no una deuda. */
const MAX_CENTAVOS = 100_000_00;
const MOTIVO_POR_DEFECTO = 'Saldo anterior al primer mes de servicio';

type Columna = 'etapa' | 'bloque' | 'casa' | 'monto' | 'motivo';

const ENCABEZADOS: Record<string, Columna> = {
  etapa: 'etapa', stage: 'etapa',
  bloque: 'bloque', block: 'bloque',
  casa: 'casa', house: 'casa',
  monto: 'monto', saldo: 'monto', saldo_inicial: 'monto', deuda: 'monto', amount: 'monto',
  motivo: 'motivo', detalle: 'motivo', nota: 'motivo',
};

export class SaldosImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaldosImportError';
  }
}

export interface SaldosImportados {
  ajustes: AjusteInput[];
  /** Viviendas del archivo que ya tenian saldo inicial. Se informan, no se cargan. */
  yaTenian: number;
}

function clave(etapa: string, bloque: string, casa: string): string {
  return `${etapa}:${bloque}:${casa}`;
}

/**
 * Se arma con la fecha y un contador y no con un aleatorio: dos importaciones
 * de la misma casa nunca colisionan, y el id dice cuando entro.
 */
function idDeAjuste(creadoEn: string, indice: number): string {
  return `aj-${creadoEn.replace(/\D/g, '').slice(0, 14)}-${String(indice).padStart(4, '0')}`;
}

export function parseSaldosImport(
  entrada: string,
  viviendas: readonly HomeRecord[],
  opciones: { yaTienenSaldo?: ReadonlySet<string>; creadoPor: string; creadoEn: string },
): SaldosImportados {
  if (!entrada.trim()) throw new SaldosImportError('La importación está vacía.');
  if (entrada.length > MAX_CARACTERES) throw new SaldosImportError('La importación es demasiado grande.');

  const lineas = entrada.replace(/^﻿/, '').split(/\r?\n/).filter((linea) => linea.trim());
  if (lineas.length < 2) throw new SaldosImportError('Incluye encabezados y al menos una vivienda.');
  if (lineas.length - 1 > MAX_FILAS) throw new SaldosImportError(`Máximo ${MAX_FILAS} viviendas por importación.`);

  const delimitador = detectarDelimitador(lineas[0]);

  let encabezados: Columna[];
  try {
    encabezados = partirLinea(lineas[0], delimitador).map((bruto) => {
      const columna = ENCABEZADOS[normalizarEncabezado(bruto)];
      if (!columna) throw new SaldosImportError(`Encabezado no reconocido: ${bruto}.`);
      return columna;
    });
  } catch (error) {
    throw error instanceof CsvPegadoError ? new SaldosImportError(error.message) : error;
  }

  if (new Set(encabezados).size !== encabezados.length) {
    throw new SaldosImportError('Hay encabezados duplicados o equivalentes.');
  }
  for (const obligatorio of ['etapa', 'bloque', 'casa', 'monto'] as const) {
    if (!encabezados.includes(obligatorio)) {
      throw new SaldosImportError(`Falta el encabezado obligatorio: ${obligatorio}.`);
    }
  }

  // La vivienda se busca por direccion: el archivo lo escribe una persona que
  // conoce la casa, no el id interno.
  const porDireccion = new Map(viviendas.map((v) => [clave(v.stage, v.block, v.house), v]));
  const yaTienenSaldo = opciones.yaTienenSaldo ?? new Set<string>();
  const vistas = new Set<string>();

  const ajustes: AjusteInput[] = [];
  let yaTenian = 0;

  lineas.slice(1).forEach((linea, indice) => {
    const numero = indice + 2;

    let valores: string[];
    try {
      valores = partirLinea(linea, delimitador);
    } catch (error) {
      throw error instanceof CsvPegadoError ? new SaldosImportError(`Línea ${numero}: ${error.message}`) : error;
    }

    const campo = (columna: Columna): string => valores[encabezados.indexOf(columna)]?.trim() ?? '';

    const etapa = normalizeHomePart(campo('etapa'));
    const bloque = normalizeHomePart(campo('bloque'));
    const casa = normalizeHomePart(campo('casa'));
    if (!isValidHome(etapa, bloque, casa)) {
      throw new SaldosImportError(`Línea ${numero}: etapa, bloque y casa son obligatorios.`);
    }

    const direccion = clave(etapa, bloque, casa);
    if (vistas.has(direccion)) throw new SaldosImportError(`Línea ${numero}: la vivienda aparece dos veces.`);
    vistas.add(direccion);

    const vivienda = porDireccion.get(direccion);
    // Falla, no crea la vivienda: una casa que no esta en el padron casi
    // siempre es un error de tipeo, y darla de alta desde aca la dejaria sin
    // fecha de alta ni cuota.
    if (!vivienda) throw new SaldosImportError(`Línea ${numero}: esa vivienda no está en el padrón.`);

    if (yaTienenSaldo.has(vivienda.id)) {
      yaTenian += 1;
      return;
    }

    const centavos = aCentavos(campo('monto'));
    if (centavos === undefined) throw new SaldosImportError(`Línea ${numero}: monto inválido.`);
    if (centavos <= 0) throw new SaldosImportError(`Línea ${numero}: el saldo tiene que ser mayor que cero.`);
    if (centavos > MAX_CENTAVOS) throw new SaldosImportError(`Línea ${numero}: el saldo es demasiado alto.`);

    ajustes.push({
      id: idDeAjuste(opciones.creadoEn, ajustes.length),
      viviendaId: vivienda.id,
      tipo: 'SALDO_INICIAL',
      montoCentavos: centavos,
      motivo: campo('motivo') || MOTIVO_POR_DEFECTO,
      creadoPor: opciones.creadoPor,
    });
  });

  if (ajustes.length === 0 && yaTenian === 0) throw new SaldosImportError('No hay ninguna vivienda para cargar.');
  return { ajustes, yaTenian };
}
