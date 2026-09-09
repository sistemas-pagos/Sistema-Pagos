import type { HomeRef } from './types';

const STAGE = /\bE(?:TAPA)?\s*[:#.-]?\s*(\d{1,3})\b/i;
const BLOCK = /\bB(?:LOQUE)?\s*[:#.-]?\s*(\d{1,3})\b/i;
const HOUSE = /\bC(?:ASA)?\s*[:#.-]?\s*(\d{1,4})\b/i;

export function parseHomeReference(input: string | undefined | null): HomeRef | undefined {
  if (!input) return undefined;
  const normalized = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const stageMatch = normalized.match(STAGE);
  const blockMatch = normalized.match(BLOCK);
  const houseMatch = normalized.match(HOUSE);
  if (!stageMatch || !blockMatch || !houseMatch) return undefined;

  const stage = Number.parseInt(stageMatch[1], 10);
  const block = Number.parseInt(blockMatch[1], 10);
  const house = Number.parseInt(houseMatch[1], 10);
  return isValidHome(stage, block, house) ? { stage, block, house } : undefined;
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
