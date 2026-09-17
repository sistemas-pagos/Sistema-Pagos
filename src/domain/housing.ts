import type { HomeRef } from './types';

/**
 * Etiquetas sueltas, en cualquier orden: "Casa 18, Bloque 4, Etapa 1".
 *
 * La letra sola exige no venir seguida de otra letra. Sin eso, `C` enganchaba
 * la de "Condominio" y se llevaba "ONDOM" como numero de casa, y `E(?:TAPA)?`
 * enganchaba la de "4ta etapa" y devolvia la etapa "TAPA" con toda confianza.
 * Ese fallo era peor que no leer nada: un comprobante legible se asignaba a una
 * vivienda inexistente sin una sola advertencia.
 *
 * Se prueban en orden y gana la primera que acierta, de la forma mas explicita
 * a la mas escueta.
 */
const STAGE: readonly RegExp[] = [
  /\bETAPA\s*[:#.-]?\s*([A-Z0-9]{1,4})\b/i,
  /\b(\d{1,2})\s*(?:ERA|ERO|RA|DA|TA|VA|MA|[ºo°])?\.?\s*ETAPA\b/i,
  /\b(PRIMERA|PRIMER|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|SEPTIMA|OCTAVA|NOVENA|DECIMA)\s+ETAPA\b/i,
  /\bE(?![A-Z])\s*[:#.-]?\s*([A-Z0-9]{1,4})\b/i,
];

const BLOCK: readonly RegExp[] = [
  /\bBLOQUES?\s*[:#.-]?\s*([A-Z0-9]{1,4})\b/i,
  /\bB(?![A-Z])\s*[:#.-]?\s*([A-Z0-9]{1,4})\b/i,
];

const HOUSE: readonly RegExp[] = [
  /\bCASAS?\s*[:#.-]?\s*([A-Z0-9]{1,5})\b/i,
  /\bC(?![A-Z])\s*[:#.-]?\s*([A-Z0-9]{1,5})\b/i,
];

/** Los vecinos escriben la etapa en palabras tan seguido como en numero. */
const ORDINALES: Record<string, string> = {
  PRIMERA: '1', PRIMER: '1', SEGUNDA: '2', TERCERA: '3', CUARTA: '4', QUINTA: '5',
  SEXTA: '6', SEPTIMA: '7', OCTAVA: '8', NOVENA: '9', DECIMA: '10',
};

function primerAcierto(texto: string, patrones: readonly RegExp[]): string | undefined {
  for (const patron of patrones) {
    const encontrado = texto.match(patron)?.[1];
    if (encontrado) return ORDINALES[encontrado.toUpperCase()] ?? encontrado;
  }
  return undefined;
}

/**
 * Codigo compacto, en el orden Etapa-Bloque-Casa y sin necesidad de espacios:
 * `E1B4C18`, `e1b4c18`, `E1 B4 C18`, `Etapa1Bloque4Casa18` y, con letras,
 * `E1BAC18` (bloque A) o `E1B4C18B` (casa 18B).
 *
 * Es el formato que el sistema le pide al vecino, asi que es el que mas llega.
 */
const COMPACT = /\b(?:ETAPA|E(?![A-Z]))\s*[:#.-]?\s*([A-Z0-9]{1,4})\s*(?:BLOQUE|B)\s*[:#.-]?\s*([A-Z0-9]{1,4})\s*(?:CASA|C)\s*[:#.-]?\s*([A-Z0-9]{1,5})\b/i;

const VALID_PART = /^[A-Z0-9]{1,5}$/;

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/**
 * Deja una parte de la vivienda en su forma canonica.
 *
 * Mayusculas, sin acentos y sin espacios, para que 'a' y 'A' sean el mismo
 * bloque. Los valores puramente numericos pierden los ceros a la izquierda, asi
 * que '018' y '18' son la misma casa; los que tienen letras se respetan tal
 * cual, porque ahi el cero puede ser parte del nombre.
 */
export function normalizeHomePart(value: string): string {
  const cleaned = stripDiacritics(value).replace(/\s+/g, '').toUpperCase();
  return /^\d+$/.test(cleaned) ? String(Number.parseInt(cleaned, 10)) : cleaned;
}

export function normalizeHome(home: HomeRef): HomeRef {
  return {
    stage: normalizeHomePart(home.stage),
    block: normalizeHomePart(home.block),
    house: normalizeHomePart(home.house),
  };
}

export function isValidHome(stage: string, block: string, house: string): boolean {
  return [stage, block, house].every((part) => {
    const normalized = normalizeHomePart(part ?? '');
    // '0' no identifica nada: es lo que queda de un campo vacio o en cero.
    return VALID_PART.test(normalized) && normalized !== '0';
  });
}

function build(stage: string, block: string, house: string): HomeRef | undefined {
  if (!isValidHome(stage, block, house)) return undefined;
  return normalizeHome({ stage, block, house });
}

export function parseHomeReference(input: string | undefined | null): HomeRef | undefined {
  if (!input) return undefined;
  const normalized = stripDiacritics(input).replace(/\s+/g, ' ').trim();

  const compact = normalized.match(COMPACT);
  if (compact) return build(compact[1], compact[2], compact[3]);

  const stage = primerAcierto(normalized, STAGE);
  const block = primerAcierto(normalized, BLOCK);
  const house = primerAcierto(normalized, HOUSE);
  if (!stage || !block || !house) return undefined;

  return build(stage, block, house);
}

export function sameHomeRef(a: HomeRef, b: HomeRef): boolean {
  return a.stage === b.stage && a.block === b.block && a.house === b.house;
}

/** El codigo compacto de la vivienda: E1B4C18. */
export function homeCode(home: HomeRef): string {
  return `E${home.stage}B${home.block}C${home.house}`;
}

export function homeLabel(home: HomeRef | undefined): string {
  return home ? `Etapa ${home.stage} · Bloque ${home.block} · Casa ${home.house}` : 'Sin identificar';
}

/**
 * Ordena dos partes de vivienda. Numerico cuando las dos lo son, para que la
 * casa 9 vaya antes que la 10; alfabetico en cuanto aparece una letra.
 */
export function compareHomeParts(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  // Los numeros van primero: el bloque 4 antes que el bloque A.
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a.localeCompare(b, 'es');
}

/** Orden natural de viviendas: por etapa, luego bloque, luego casa. */
export function compareHomes(a: HomeRef, b: HomeRef): number {
  return compareHomeParts(a.stage, b.stage)
    || compareHomeParts(a.block, b.block)
    || compareHomeParts(a.house, b.house);
}
