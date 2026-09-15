import { describe, expect, it } from 'vitest';
import { validateEnv } from '../../config/env';

describe('SMS provider configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a-production-secret-that-is-long-enough',
    TOTP_ENCRYPTION_KEY: 'x'.repeat(44),
  };

  it('refuses to start production with codes written to the log', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', SMS_PROVIDER: 'log' })).toThrow(
      /SMS_PROVIDER/,
    );
  });

  it('starts production with no provider chosen yet, and development with the log', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'production' }).SMS_PROVIDER).toBeUndefined();
    expect(validateEnv({ ...base, NODE_ENV: 'development', SMS_PROVIDER: 'log' }).SMS_PROVIDER).toBe(
      'log',
    );
  });

  it('accepts no provider it does not know', () => {
    expect(() => validateEnv({ ...base, SMS_PROVIDER: 'carrier-pigeon' })).toThrow(/SMS_PROVIDER/);
  });
});
