import { describe, expect, it } from 'vitest';
import { validateEnv } from '../../config/env';

describe('SMS provider configuration', () => {
  // Everything a deployed environment needs, so that the assertions below are
  // about the SMS provider and nothing else (sp7-plan.md, T2).
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a-production-secret-that-is-long-enough',
    TOTP_ENCRYPTION_KEY: 'x'.repeat(43),
    CORS_ORIGINS: 'https://clinical.health24.in',
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

  it('refuses to start production with codes written to a file', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', SMS_LOG_FILE: '/tmp/sms.jsonl' }),
    ).toThrow(/SMS_LOG_FILE/);

    expect(
      validateEnv({ ...base, NODE_ENV: 'development', SMS_LOG_FILE: '/tmp/sms.jsonl' })
        .SMS_LOG_FILE,
    ).toBe('/tmp/sms.jsonl');
  });
});
