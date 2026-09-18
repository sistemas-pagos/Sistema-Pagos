import { parseHomeReference } from '@/src/domain/housing';
import type { ReceiptExtraction } from '@/src/domain/types';
import type { ReceiptParser } from '@/src/parsers/types';

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function linesOf(text: string): string[] {
  return text.replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Una linea que abre una etiqueta nueva: "Referencia: 123", "Monto L150.00".
 * Sirve para saber donde termina el valor de la etiqueta anterior.
 */
const ABRE_ETIQUETA = /^[A-Za-zÁÉÍÓÚÑáéíóúñ°º .]{3,28}[:\s]\s*\S/;

const ETIQUETAS_CONOCIDAS = [
  'FECHA', 'HORA', 'MONTO', 'DETALLE', 'DESCRIPCION', 'REFERENCIA', 'AUTORIZACION',
  'CLIENTE', 'TERMINAL', 'LOTE', 'CUENTA', 'TIPO', 'COMPROBANTE', 'CONCEPTO', 'MOTIVO',
];

function abreOtraEtiqueta(linea: string): boolean {
  const normalizada = stripDiacritics(linea).toUpperCase();
  if (ETIQUETAS_CONOCIDAS.some((etiqueta) => normalizada.startsWith(etiqueta))) return true;
  return ABRE_ETIQUETA.test(linea) && /:/.test(linea.slice(0, 28));
}

/**
 * El valor de una etiqueta, siguiendo la continuacion si ocupa mas de una linea.
 *
 * El BAC parte los valores largos: el detalle "Pago Septiembre, Tercera etapa,
 * bloque 45, casa 5" llega en dos lineas, y quedarse con la primera pierde la
 * vivienda entera. El nombre del titular en el comprobante de agente se corta
 * igual, a la mitad de una palabra.
 *
 * La continuacion se reconoce por descarte: una linea que no abre otra etiqueta
 * conocida pertenece a la anterior.
 */
function findLabel(lines: readonly string[], labels: readonly string[]): string | undefined {
  const normalizedLabels = labels.map((label) => stripDiacritics(label).toUpperCase());

  // Las etiquetas van en el bucle de afuera porque la lista es una prioridad, no
  // un conjunto: en el comprobante de agente, 'Referencia' aparece antes que
  // 'Autorizacion' en el papel, y recorriendo lineas primero ganaba la de arriba
  // en vez de la que se pidio primero.
  for (const label of normalizedLabels) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const normalized = stripDiacritics(line).toUpperCase();
      let value: string | undefined;

      if (normalized === label || normalized === `${label}:`) {
        value = lines[index + 1];
        // La etiqueta ocupaba su propia linea: el valor empieza en la siguiente
        // y la continuacion, si la hay, viene despues.
        if (value) return conContinuacion(lines, index + 1, value);
        continue;
      }

      if (normalized.startsWith(`${label}:`) || normalized.startsWith(`${label} `)) {
        // Se recorta exactamente la etiqueta. Cortar hasta el primer ':' de la
        // linea partia "Hora 2:45 PM" en "45 PM", porque el primer ':' era el de
        // la hora y no el de la etiqueta.
        value = line.slice(label.length).replace(/^\s*[:\-]?\s*/, '').trim();
        if (value) return conContinuacion(lines, index, value);
      }
    }
  }
  return undefined;
}

function conContinuacion(lines: readonly string[], desde: number, valor: string): string {
  let completo = valor;
  for (let index = desde + 1; index < lines.length; index += 1) {
    const siguiente = lines[index];
    if (abreOtraEtiqueta(siguiente)) break;
    // Una continuacion que parte una palabra a la mitad ("ORELLA" / "NA") se une
    // sin espacio; una que continua la frase, con espacio.
    const pegada = /[a-z]$/.test(completo) && /^[A-Z]{1,3}$/.test(siguiente);
    completo = pegada || /[A-Z]$/.test(completo) && /^[A-Z]{1,3}$/.test(siguiente)
      ? `${completo}${siguiente}`
      : `${completo} ${siguiente}`;
  }
  return completo.trim();
}

function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.replace(/\s/g, '').match(/(?:HNL|LPS?\.?|L)?([\d.,]+)/i);
  if (!match) return undefined;
  let numeric = match[1];
  const lastComma = numeric.lastIndexOf(',');
  const lastDot = numeric.lastIndexOf('.');
  if (lastComma > lastDot) numeric = numeric.replace(/\./g, '').replace(',', '.');
  else numeric = numeric.replace(/,/g, '');
  const amount = Number.parseFloat(numeric);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

const MESES: Record<string, string> = {
  ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
  JUL: '07', AGO: '08', SEP: '09', SET: '09', OCT: '10', NOV: '11', DIC: '12',
};

/** '07 de septiembre de 2026', '7 sep 2026', '7-SEP-2026'. */
function parseTextualDate(value: string): string | undefined {
  const match = stripDiacritics(value).toUpperCase()
    .match(/\b(\d{1,2})\s*(?:DE\s+)?[-\/ ]?\s*([A-Z]{3,10})\.?\s*(?:DE\s+)?[-\/ ]?\s*(\d{4})\b/);
  if (!match) return undefined;
  const month = MESES[match[2].slice(0, 3)];
  return month ? `${match[3]}-${month}-${match[1].padStart(2, '0')}` : undefined;
}

/**
 * La pantalla de resultado de la app escribe "14 septiembre", sin anio.
 *
 * Se toma el anio mas reciente que no deje la fecha en el futuro. Un
 * comprobante es siempre de un pago ya hecho, asi que una fecha por delante de
 * hoy solo puede ser del anio pasado: en enero, un "28 diciembre" es de
 * diciembre pasado y no del que viene.
 */
function parseDateWithoutYear(value: string, hoy: Date): string | undefined {
  const match = stripDiacritics(value).toUpperCase().match(/\b(\d{1,2})\s*(?:DE\s+)?([A-Z]{3,10})\b(?!\s*\d{4})/);
  if (!match) return undefined;
  const month = MESES[match[2].slice(0, 3)];
  if (!month) return undefined;

  const day = match[1].padStart(2, '0');
  const hoyIso = hoy.toISOString().slice(0, 10);
  const candidato = `${hoy.getUTCFullYear()}-${month}-${day}`;
  return candidato <= hoyIso ? candidato : `${hoy.getUTCFullYear() - 1}-${month}-${day}`;
}

function parseDate(value: string | undefined, text: string, hoy: Date): string | undefined {
  const source = value ?? text;
  const numeric = source.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (numeric) {
    const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
    return `${year}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}`;
  }
  return parseTextualDate(source) ?? parseDateWithoutYear(source, hoy);
}

function parseTime(value: string | undefined, text: string): string | undefined {
  const match = (value ?? text).match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?\b/i);
  if (!match) return undefined;
  let hour = Number.parseInt(match[1], 10);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function normalizeReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.toUpperCase().match(/[A-Z0-9][A-Z0-9\-]{5,}/)?.[0];
}

/**
 * El beneficiario y la cuenta de destino, que el BAC nunca pone tras una
 * etiqueta llamada "Beneficiario".
 *
 * Aparecen de tres formas segun el comprobante, y sin leer las tres no se puede
 * comprobar a que cuenta entro el dinero (invariante 4), que es lo unico que
 * separa un deposito nuestro de uno a la cuenta de otra persona:
 *
 *   1. Dentro de la frase: "a la cuenta bancaria Nº 900112233 a nombre de X".
 *   2. Bajo "Cuenta destino", con el nombre y el numero en lineas seguidas.
 *   3. En el comprobante de agente: "Cliente:" y "Numero de Cuenta:" aparte.
 */
function siTiene(value: string | undefined): string | undefined {
  const limpio = value?.trim();
  return limpio ? limpio : undefined;
}

function datosDeDestino(
  lines: readonly string[],
  plano: string,
): { beneficiary?: string; account?: string } {
  const frase = plano.match(
    /CUENTA\s+BANCARIA\s*N?[º°o.]*\s*([\d*-]{4,})\s*A\s+NOMBRE\s+DE\s+([^.]+)/i,
  );
  if (frase) return { account: frase[1], beneficiary: siTiene(frase[2]) };

  // "Cuenta destino" trae a veces el nombre y el numero juntos y a veces solo el
  // numero. Los dos campos se resuelven por separado para que un bloque sin
  // nombre no devuelva un beneficiario vacio, que pasaria la comprobacion de
  // "hay dato" y fallaria la comparacion con un mensaje que no explica nada.
  const bloque = findLabel(lines, ['Cuenta destino', 'Cuenta beneficiaria', 'Cuenta de destino']);
  const partido = bloque?.match(/^(.*?)\s*([\d*-]{4,})\s*$/);

  return {
    beneficiary: siTiene(partido?.[1])
      ?? findLabel(lines, ['Beneficiario', 'A nombre de', 'Nombre del beneficiario', 'Cliente']),
    account: partido?.[2] ?? bloque ?? findLabel(lines, ['Número de Cuenta', 'Numero de Cuenta']),
  };
}

function maskAccount(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : undefined;
}

export const bacParser: ReceiptParser = {
  id: 'bac-honduras',
  /**
   * Reconoce el comprobante por tres senales independientes y pide dos.
   *
   * Antes bastaba con la palabra "BAC" y eso resulto fragil de verdad: la
   * captura de una notificacion con el banner de "Favorito guardado" tapando el
   * logo, y la pantalla de resultado de la app, que no escribe "BAC" en ningun
   * lado, se rechazaban enteras como banco no soportado. Dos de cada ocho
   * comprobantes reales se perdian antes de empezar a leerlos.
   *
   * Una sola senal nunca alcanza para llegar al umbral: es a proposito, para
   * que un comprobante de otro banco no entre por parecerse en las etiquetas.
   */
  detect(text: string): number {
    const normalized = stripDiacritics(text).toUpperCase();

    const marca = /\bBAC\b|CREDOMATIC|BANCO DE AMERICA CENTRAL|RAPIBAC|CNB HONDURAS/.test(normalized);
    const documento = /NOTIFICACION DE TRANSFERENCIA|RESULTADO DE TRANSFERENCIA|COPIA DEL CLIENTE|TIPO DE TRANSACCION/.test(normalized);
    const etiquetas = ['FECHA', 'HORA', 'MONTO', 'DETALLE', 'DESCRIPCION', 'REFERENCIA', 'COMPROBANTE', 'CUENTA']
      .filter((etiqueta) => normalized.includes(etiqueta)).length;

    let score = 0;
    if (marca) score += 0.45;
    if (documento) score += 0.35;
    if (etiquetas >= 4) score += 0.2;
    return Math.min(1, score);
  },
  parse(text: string, hoy: Date = new Date()): ReceiptExtraction {
    const lines = linesOf(text);
    const plano = lines.join(' ');
    // Sin respaldo al mayor monto del texto: un comprobante que no dice su monto
    // en una etiqueta clara va a revision, no se adivina.
    const amount = parseMoney(findLabel(lines, ['Monto', 'Monto transferido', 'Total', 'Importe']));
    // El BAC escribe literalmente "(Sin detalle)" cuando el vecino no puso nada;
    // guardarlo como detalle seria guardar la ausencia de detalle como si fuera uno.
    const detalleCrudo = findLabel(lines, ['Detalle', 'Descripción', 'Descripcion', 'Concepto', 'Motivo']);
    const detail = detalleCrudo && !/^\(?SIN DETALLE\)?$/i.test(detalleCrudo.trim()) ? detalleCrudo : undefined;
    // Solo del detalle. Buscarlo en todo el texto agarra numeros de cuenta y
    // referencias que casualmente parecen una vivienda.
    const home = parseHomeReference(detail);
    // 'Transaccion' a secas capturaba lineas como 'Transaccion exitosa' y las
    // guardaba como referencia bancaria.
    // 'Autorizacion' primero: en el comprobante de agente convive con una
    // 'Referencia' de seis digitos que es el contador interno de la pulperia y
    // se repite entre agentes distintos. Usarla como referencia bancaria haria
    // que dos pagos de pulperias distintas parecieran el mismo.
    const reference = normalizeReference(findLabel(lines, [
      'Autorización', 'Autorizacion',
      'Referencia', 'N° comprobante', 'No comprobante', 'Numero de comprobante',
      'No. de transacción', 'No de transaccion', 'Número de transacción', 'Numero de transaccion',
      'Número de confirmación', 'Numero de confirmacion',
    ]));
    // 'De' y 'Destino' eran demasiado genericas para ser etiquetas.
    const depositor = findLabel(lines, ['Depositante', 'Remitente', 'Ordenante', 'Nombre del ordenante']);
    const { beneficiary, account: destinationAccount } = datosDeDestino(lines, plano);
    const warnings: string[] = [];
    if (!amount) warnings.push('amount_missing');
    if (!reference) warnings.push('reference_missing');
    if (!home) warnings.push('home_missing');
    const confidence = bacParser.detect(text) + (amount ? 0.1 : 0) + (reference ? 0.1 : 0) + (home ? 0.05 : 0);

    return {
      bank: 'BAC Honduras',
      depositor,
      transactionDate: parseDate(findLabel(lines, ['Fecha', 'Fecha de transacción', 'Fecha de transaccion']), text, hoy),
      transactionTime: parseTime(findLabel(lines, ['Hora', 'Hora de transacción', 'Hora de transaccion']), text),
      amount,
      detail,
      reference,
      beneficiary,
      destinationAccountMasked: maskAccount(destinationAccount),
      home,
      confidence: Math.min(1, confidence),
      rawText: text,
      warnings,
    };
  },
};
