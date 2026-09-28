import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateEnv } from './env';

/**
 * What the process refuses to start with (sp7-plan.md, T2, DF2).
 *
 * Each of these is a mistake that would otherwise be found in production, by
 * somebody who is not looking for it: a signing secret left at its
 * development value, a key that is the right length but not a key, static
 * storage credentials sitting in the environment of a task that has an IAM
 * role.
 */

const key = () => crypto.randomBytes(32).toString('base64url');

const development = () => ({
  DATABASE_URL: 'postgres://app:pw@localhost:5432/health24',
  JWT_ACCESS_SECRET: 'dev_only_replace_me_access',
  TOTP_ENCRYPTION_KEY: key(),
});

const production = () => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://app:pw@db.internal:5432/health24',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('base64url'),
  TOTP_ENCRYPTION_KEY: key(),
  CORS_ORIGINS: 'https://clinical.health24.in',
  SMS_PROVIDER: undefined,
  STORAGE_REGION: 'ap-south-1',
});

const refusal = (raw: Record<string, unknown>): string => {
  try {
    validateEnv(raw);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('Expected the configuration to be refused, and it was not');
};

describe('environment validation', () => {
  it('accepts an ordinary development environment', () => {
    const env = validateEnv(development());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.STORAGE_REGION).toBe('ap-south-1');
  });

  it('accepts a production environment that has everything it needs', () => {
    expect(validateEnv(production()).NODE_ENV).toBe('production');
  });

  it('names the variable that is wrong, rather than failing vaguely', () => {
    const message = refusal({ ...development(), DATABASE_URL: 'not-a-url' });

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('Invalid environment configuration');
  });

  it('refuses an encryption key that is not 32 bytes', () => {
    // The right length as a string, the wrong length as a key.
    expect(refusal({ ...development(), TOTP_ENCRYPTION_KEY: 'x'.repeat(44) })).toContain(
      'TOTP_ENCRYPTION_KEY',
    );
    expect(refusal({ ...development(), TOTP_ENCRYPTION_KEY: 'short' })).toContain(
      'TOTP_ENCRYPTION_KEY',
    );
  });

  it('refuses a rotation where the old key is the new one', () => {
    const same = key();

    expect(
      refusal({
        ...development(),
        TOTP_ENCRYPTION_KEY: same,
        TOTP_ENCRYPTION_KEY_PREVIOUS: same,
      }),
    ).toContain('TOTP_ENCRYPTION_KEY_PREVIOUS');

    const deployed = production();

    expect(
      refusal({ ...deployed, JWT_ACCESS_SECRET_PREVIOUS: deployed.JWT_ACCESS_SECRET }),
    ).toContain('JWT_ACCESS_SECRET_PREVIOUS');
  });

  it('accepts both keys while a rotation is running', () => {
    const env = validateEnv({
      ...development(),
      TOTP_ENCRYPTION_KEY_PREVIOUS: key(),
      JWT_ACCESS_SECRET_PREVIOUS: 'the-secret-it-replaced',
    });

    expect(env.TOTP_ENCRYPTION_KEY_PREVIOUS).toBeTruthy();
    expect(env.JWT_ACCESS_SECRET_PREVIOUS).toBe('the-secret-it-replaced');
  });

  describe('in production', () => {
    it('refuses the development signing secret, and a short one', () => {
      expect(refusal({ ...production(), JWT_ACCESS_SECRET: 'dev_only_replace_me_access' })).toContain(
        'development JWT secret',
      );
      expect(refusal({ ...production(), JWT_ACCESS_SECRET: 'sixteen-chars-ok' })).toContain(
        'shorter than 32 characters',
      );
    });

    it('refuses to run without the queue, or with the owner connection', () => {
      const { REDIS_URL: _redis, ...withoutRedis } = production();
      expect(refusal(withoutRedis)).toContain('REDIS_URL');

      expect(
        refusal({ ...production(), DATABASE_ADMIN_URL: 'postgres://owner@db.internal:5432/h24' }),
      ).toContain('DATABASE_ADMIN_URL');
    });

    it('refuses static storage credentials, which the task role supplies instead', () => {
      expect(refusal({ ...production(), STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE' })).toContain(
        'task role',
      );

      // Including when an endpoint is set, if that endpoint is on the internet.
      expect(
        refusal({
          ...production(),
          STORAGE_ENDPOINT: 'https://storage.example.com',
          STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE',
          STORAGE_SECRET_ACCESS_KEY: 'secret',
        }),
      ).toContain('task role');
    });

    it('allows a storage container on its own network, which has no task role', () => {
      // What `docker-compose.prod.yml` runs: the production configuration in
      // every respect except that storage is a container beside it (T15). A
      // stack that cannot boot is a stack nobody runs.
      const env = validateEnv({
        ...production(),
        STORAGE_ENDPOINT: 'http://storage:7070',
        STORAGE_ACCESS_KEY_ID: 'local',
        STORAGE_SECRET_ACCESS_KEY: 'local-secret',
      });

      expect(env.STORAGE_ENDPOINT).toBe('http://storage:7070');
    });

    it('refuses to answer origins nobody named', () => {
      const { CORS_ORIGINS: _origins, ...withoutOrigins } = production();
      expect(refusal(withoutOrigins)).toContain('CORS_ORIGINS');
    });

    it('keeps patient data in India, and off plain HTTP', () => {
      expect(refusal({ ...production(), STORAGE_REGION: 'eu-west-1' })).toContain('ap-south-1');
      // A name with dots in it can be resolved from the internet, so plain
      // HTTP to it is a patient's scan in clear on the wire.
      expect(refusal({ ...production(), STORAGE_ENDPOINT: 'http://storage.internal' })).toContain(
        'plain HTTP',
      );
    });

    it('refuses to send sign-in codes to a log or a file', () => {
      expect(refusal({ ...production(), SMS_PROVIDER: 'log' })).toContain('SMS_PROVIDER');
      expect(refusal({ ...production(), SMS_LOG_FILE: '/tmp/sms.jsonl' })).toContain('SMS_LOG_FILE');
    });

    it('refuses a mocked national registry', () => {
      // A mock that accepts a well-known code is a way to mark any ABHA
      // verified without the patient being there (sp8-plan.md, T9).
      expect(refusal({ ...production(), ABDM_MODE: 'mock' })).toContain('ABDM');
      expect(() => validateEnv({ ...production(), ABDM_MODE: 'off' })).not.toThrow();
    });

    it('refuses a half-configured gateway, naming what is missing', () => {
      // Half-configured is the worst of the three states: it looks enabled
      // and fails on the first call (sp8-plan.md, T9).
      const message = refusal({ ...production(), ABDM_MODE: 'gateway' });

      expect(message).toContain('ABDM_GATEWAY_URL');
      expect(message).toContain('ABDM_CLIENT_SECRET');
      expect(message).toContain('ABDM_HIP_ID');
    });

    it('refuses to talk to the gateway in clear, or to trust an unsigned callback', () => {
      const configured = {
        ...production(),
        ABDM_MODE: 'gateway',
        ABDM_CLIENT_ID: 'health24',
        ABDM_CLIENT_SECRET: 'a-real-client-secret',
        ABDM_HIP_ID: 'HFR-0001',
        ABDM_CM_ID: 'abdm',
        ABDM_CALLBACK_SECRET: 'a-real-callback-secret',
      };

      expect(refusal({ ...configured, ABDM_GATEWAY_URL: 'http://gateway.abdm.gov.in' })).toContain(
        'plain HTTP',
      );

      expect(
        refusal({
          ...configured,
          ABDM_GATEWAY_URL: 'https://gateway.abdm.gov.in',
          ABDM_CALLBACK_SECRET: undefined,
        }),
      ).toContain('unauthenticated ABDM callbacks');

      expect(() =>
        validateEnv({ ...configured, ABDM_GATEWAY_URL: 'https://gateway.abdm.gov.in' }),
      ).not.toThrow();
    });

    it('refuses demo terminology on real records', () => {
      expect(refusal({ ...production(), ALLOW_DEMO_TERMINOLOGY: 'true' })).toContain(
        'demo terminology',
      );
    });
  });
});
