import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/src/config/env';
import { createAdminSession, verifyAdminAccessKey, verifyAdminSession } from '@/src/auth/session';

beforeEach(() => {
  process.env.ADMIN_ACCESS_KEY = 'synthetic-admin-key-that-is-not-production';
  process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-that-is-not-production';
  resetEnvForTests();
});

afterEach(() => {
  delete process.env.ADMIN_ACCESS_KEY;
  delete process.env.AUTH_SESSION_SECRET;
  resetEnvForTests();
});

describe('admin authentication', () => {
  it('rejects unauthorized access keys', () => {
    expect(verifyAdminAccessKey('wrong-key')).toBe(false);
    expect(verifyAdminAccessKey('synthetic-admin-key-that-is-not-production')).toBe(true);
  });

  it('signs sessions and rejects tampering or expiration', () => {
    const now = new Date('2026-09-08T18:00:00.000Z');
    const token = createAdminSession(now);
    expect(verifyAdminSession(token, new Date('2026-09-08T18:01:00.000Z'))).toBe(true);
    expect(verifyAdminSession(`${token}tampered`, now)).toBe(false);
    expect(verifyAdminSession(token, new Date('2026-09-09T03:00:00.000Z'))).toBe(false);
  });
});
