import type { HomeRef } from './types';

// Etiquetas sueltas: admiten cualquier orden ("Casa 18, Bloque 4, Etapa 1").
const STAGE = /\bE(?:TAPA)?\s*[:#.-]?\s*([A-Z0-9]{1,4})\b/i;
const BLOCK = /\bB(?:LOQUE)?\s*[:#.-]?\s*([A-Z0-9]{1,4})\b/i;
const HOUSE = /\bC(?:ASA)?\s*[:#.-]?\s*([A-Z0-9]{1,5})\b/i;

/**
 * Codigo compacto, en el orden Etapa-Bloque-Casa y sin necesidad de espacios:
 * `E1B4C18`, `e1b4c18`, `E1 B4 C18`, `Etapa1Bloque4Casa18` y, con letras,
 * `E1BAC18` (bloque A) o `E1B4C18B` (casa 18B).
 *
 * Es el formato que el sistema le pide al vecino, asi que es el que mas llega.
 */
const COMPACT = /\bE(?:TAPA)?\s*[:#.-]?\s*([A-Z0-9]{1,4})\s*B(?:LOQUE)?\s*[:#.-]?\s*([A-Z0-9]{1,4})\s*C(?:ASA)?\s*[:#.-]?\s*([A-Z0-9]{1,5})\b/i;

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

  const stageMatch = normalized.match(STAGE);
  const blockMatch = normalized.match(BLOCK);
  const houseMatch = normalized.match(HOUSE);
  if (!stageMatch || !blockMatch || !houseMatch) return undefined;

  return build(stageMatch[1], blockMatch[1], houseMatch[1]);
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
