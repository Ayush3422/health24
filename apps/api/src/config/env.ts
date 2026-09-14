import { z } from 'zod';

/**
 * Environment validation.
 *
 * The process refuses to start if configuration is missing or malformed. A
 * clinical API that boots with a placeholder JWT secret is worse than one that
 * does not boot at all.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /** The application's unprivileged connection. Row-level security binds to it. */
    DATABASE_URL: z.string().url(),
    /** The owner connection. Migrations and seeding only; never the running API. */
    DATABASE_ADMIN_URL: z.string().url().optional(),
    /** Queues for background work: scanning uploads (SP4). */
    REDIS_URL: z.string().url().optional(),

    JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    TOTP_ISSUER: z.string().default('Health24'),
    /**
     * Encrypts TOTP secrets at rest. Must decode to exactly 32 bytes — a TOTP
     * secret is a bearer credential, and a database dump holding them in clear
     * would hand an attacker every user's second factor.
     */
    TOTP_ENCRYPTION_KEY: z.string().min(32),

    CORS_ORIGINS: z.string().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /**
     * Whether synthetic DEMO- terminology may be coded onto a patient record.
     * Defaults to allowed outside production and refused in it; allowing it in
     * production is refused at startup.
     */
    ALLOW_DEMO_TERMINOLOGY: z.enum(['true', 'false']).optional(),

    /**
     * Object storage for documents (SP4). AWS S3 in Mumbai in production; any
     * S3-compatible server locally, reached through STORAGE_ENDPOINT.
     */
    STORAGE_BUCKET: z.string().min(3).default('health24-documents'),
    STORAGE_REGION: z.string().default('ap-south-1'),
    /** Only for a local S3-compatible server. Production uses AWS's own endpoint. */
    STORAGE_ENDPOINT: z.string().url().optional(),
    /** Local only: in production the task's IAM role supplies credentials. */
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

    /** clamd, which scans every upload before it can be served. */
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    SCAN_QUEUE_NAME: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Data residency is a legal requirement: patient documents stay in India.
    if (env.NODE_ENV === 'production' && env.STORAGE_REGION !== 'ap-south-1') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_REGION'],
        message:
          'Refusing to start in production with document storage outside ap-south-1 (Mumbai)',
      });
    }

    if (env.NODE_ENV === 'production' && env.STORAGE_ENDPOINT?.startsWith('http:')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_ENDPOINT'],
        message: 'Refusing to start in production with document storage over plain HTTP',
      });
    }

    // Development placeholders must never reach a deployed environment.
    if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET.startsWith('dev_only')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Refusing to start in production with the development JWT secret',
      });
    }

    // Demo codes carry no clinical meaning; on a real record they would be a
    // falsified diagnosis.
    if (env.NODE_ENV === 'production' && env.ALLOW_DEMO_TERMINOLOGY === 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_DEMO_TERMINOLOGY'],
        message: 'Refusing to start in production with demo terminology allowed on patient records',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}
