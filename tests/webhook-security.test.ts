import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature, verifyWebhookChallenge } from '@/src/whatsapp/security';

describe('WhatsApp webhook security', () => {
  it('accepts the exact HMAC-SHA256 signature only', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account' });
    const secret = 'synthetic-test-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, signature, secret)).toBe(true);
    expect(verifyMetaSignature(`${body}x`, signature, secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=00', secret)).toBe(false);
  });

  it('only returns a challenge when verification token and mode match', () => {
    const params = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'demo-token', 'hub.challenge': '12345' });
    expect(verifyWebhookChallenge(params, 'demo-token')).toBe('12345');
    expect(verifyWebhookChallenge(params, 'other-token')).toBeUndefined();
  });
});
