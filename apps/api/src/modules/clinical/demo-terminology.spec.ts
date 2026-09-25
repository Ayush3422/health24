import { describe, expect, it } from 'vitest';
import { validateEnv } from '../../config/env';
import { demoTerminologyAllowed } from './demo-terminology';

describe('demoTerminologyAllowed', () => {
  it('allows demo codes in development and test by default', () => {
    expect(demoTerminologyAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(demoTerminologyAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(demoTerminologyAllowed({})).toBe(true);
  });

  it('refuses demo codes in production by default', () => {
    expect(demoTerminologyAllowed({ NODE_ENV: 'production' })).toBe(false);
  });

  it('can be switched off outside production', () => {
    expect(
      demoTerminologyAllowed({ NODE_ENV: 'development', ALLOW_DEMO_TERMINOLOGY: 'false' }),
    ).toBe(false);
  });

  it('never allows demo codes in production, even when asked to', () => {
    expect(demoTerminologyAllowed({ NODE_ENV: 'production', ALLOW_DEMO_TERMINOLOGY: 'true' })).toBe(
      false,
    );
  });
});

describe('environment validation', () => {
  // Everything a deployed environment needs, so that the assertions below are
  // about demo terminology and nothing else (sp7-plan.md, T2).
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a-production-secret-that-is-long-enough',
    TOTP_ENCRYPTION_KEY: 'x'.repeat(43),
    CORS_ORIGINS: 'https://clinical.health24.in',
  };

  it('refuses to start production with demo terminology allowed', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', ALLOW_DEMO_TERMINOLOGY: 'true' }),
    ).toThrow(/ALLOW_DEMO_TERMINOLOGY/);
  });

  it('starts production with demo terminology left at its default', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'production' }).ALLOW_DEMO_TERMINOLOGY).toBeUndefined();
  });
});
