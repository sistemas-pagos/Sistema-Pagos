import type { HomeRef } from './types';

// Etiquetas sueltas: admiten cualquier orden ("Casa 18, Bloque 4, Etapa 1").
const STAGE = /\bE(?:TAPA)?\s*[:#.-]?\s*(\d{1,3})\b/i;
const BLOCK = /\bB(?:LOQUE)?\s*[:#.-]?\s*(\d{1,3})\b/i;
const HOUSE = /\bC(?:ASA)?\s*[:#.-]?\s*(\d{1,4})\b/i;

/**
 * Codigo compacto, en el orden Etapa-Bloque-Casa y sin necesidad de espacios.
 *
 * Es el formato que el sistema le pide al vecino, asi que es el que mas llega:
 * `E1B4C18`, `e1b4c18`, `E1 B4 C18` y `Etapa1Bloque4Casa18` son todos validos.
 * Las etiquetas sueltas no lo reconocen porque entre "1" y "B" no hay borde de
 * palabra, y `\b` no encuentra donde cortar.
 */
const COMPACT = /\bE(?:TAPA)?\s*[:#.-]?\s*(\d{1,3})\s*B(?:LOQUE)?\s*[:#.-]?\s*(\d{1,3})\s*C(?:ASA)?\s*[:#.-]?\s*(\d{1,4})\b/i;

function normalize(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function build(stage: string, block: string, house: string): HomeRef | undefined {
  const parsed = {
    stage: Number.parseInt(stage, 10),
    block: Number.parseInt(block, 10),
    house: Number.parseInt(house, 10),
  };
  return isValidHome(parsed.stage, parsed.block, parsed.house) ? parsed : undefined;
}

export function parseHomeReference(input: string | undefined | null): HomeRef | undefined {
  if (!input) return undefined;
  const normalized = normalize(input);

  const compact = normalized.match(COMPACT);
  if (compact) return build(compact[1], compact[2], compact[3]);

  const stageMatch = normalized.match(STAGE);
  const blockMatch = normalized.match(BLOCK);
  const houseMatch = normalized.match(HOUSE);
  if (!stageMatch || !blockMatch || !houseMatch) return undefined;

  return build(stageMatch[1], blockMatch[1], houseMatch[1]);
}

export function isValidHome(stage: number, block: number, house: number): boolean {
  return Number.isInteger(stage) && Number.isInteger(block) && Number.isInteger(house)
    && stage > 0 && stage <= 999
    && block > 0 && block <= 999
    && house > 0 && house <= 9999;
}

export function homeLabel(home: HomeRef | undefined): string {
  return home ? `Etapa ${home.stage} · Bloque ${home.block} · Casa ${home.house}` : 'Sin identificar';
}
