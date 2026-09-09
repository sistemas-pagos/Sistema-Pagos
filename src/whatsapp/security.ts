import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=') || !appSecret) return false;
  const providedHex = signatureHeader.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const provided = Buffer.from(providedHex, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function verifyWebhookChallenge(params: URLSearchParams, verifyToken: string): string | undefined {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode === 'subscribe' && token === verifyToken && challenge) return challenge;
  return undefined;
}
