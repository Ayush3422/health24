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

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().optional(),

    JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    TOTP_ISSUER: z.string().default('Health24'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    // Development placeholders must never reach a deployed environment.
    if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET.startsWith('dev_only')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Refusing to start in production with the development JWT secret',
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
