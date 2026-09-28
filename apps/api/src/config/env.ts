import { z } from 'zod';

/**
 * Environment validation (sp7-plan.md, T2, DF2).
 *
 * The process refuses to start if configuration is missing or malformed. A
 * clinical API that boots with a placeholder JWT secret is worse than one that
 * does not boot at all.
 *
 * Every variable here is documented in `docs/configuration.md`, and a test
 * fails if the two drift apart. The `_PREVIOUS` keys exist so that a key can
 * be rotated without a window in which nobody can sign in — see
 * `docs/runbooks/key-rotation.md`.
 */

/**
 * Whether a storage endpoint is a server on this machine's own network.
 *
 * Real object storage is AWS's, and `STORAGE_ENDPOINT` is then unset entirely.
 * An endpoint that *is* set points either at a container beside this one — a
 * bare hostname on a private network, or a loopback address — or at something
 * on the internet, and only the second is a problem worth refusing to start
 * over. The production-like local stack (`docker-compose.prod.yml`) is the
 * first kind, and it has to be able to boot, or nobody runs it.
 */
function isLocalEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;

  try {
    const { hostname } = new URL(endpoint);

    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

    // A container name on a docker network, or a Kubernetes service: a name
    // with no dots in it cannot be resolved from the internet.
    return !hostname.includes('.');
  } catch {
    return false;
  }
}

/** A key that must decode to exactly 32 bytes, as `common/crypto.ts` requires. */
const encryptionKey = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64url').length === 32;
    } catch {
      return false;
    }
  },
  {
    message:
      'must be 32 bytes, base64url-encoded. Generate one with: ' +
      'node -e "console.log(crypto.randomBytes(32).toString(`base64url`))"',
  },
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /** The application's unprivileged connection. Row-level security binds to it. */
    DATABASE_URL: z.string().url(),
    /** The owner connection. Migrations and seeding only; never the running API. */
    DATABASE_ADMIN_URL: z.string().url().optional(),
    /** Queues for background work: scanning uploads (SP4), messages to patients (SP5). */
    REDIS_URL: z.string().url().optional(),

    JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
    /**
     * The secret this one replaced, during a rotation. Tokens are only ever
     * signed with the current secret; one signed with this one is still
     * accepted, so that a rotation does not sign everybody out.
     */
    JWT_ACCESS_SECRET_PREVIOUS: z.string().min(16).optional(),
    JWT_ACCESS_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    TOTP_ISSUER: z.string().default('Health24'),
    /**
     * Encrypts TOTP secrets at rest. Must decode to exactly 32 bytes — a TOTP
     * secret is a bearer credential, and a database dump holding them in clear
     * would hand an attacker every user's second factor.
     */
    TOTP_ENCRYPTION_KEY: encryptionKey,
    /**
     * The key this one replaced. Secrets are written with the current key and
     * read with either, which is what makes rotation possible without locking
     * every user out of their second factor. Removed once
     * `pnpm --filter @health24/api keys:rewrap` has rewritten them all.
     */
    TOTP_ENCRYPTION_KEY_PREVIOUS: encryptionKey.optional(),

    CORS_ORIGINS: z.string().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /**
     * `json` always, except on a developer's terminal, where a line per
     * request is easier to read than a JSON object per request. Production
     * ignores this and writes JSON regardless.
     */
    LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
    /**
     * Where lines are written, when they go to a file rather than to standard
     * output — a host without a log collector, or the test that proves no
     * patient reaches a log line.
     */
    LOG_FILE: z.string().optional(),

    /**
     * The port the worker serves its liveness probe and its metrics on. It has
     * no API: two paths, and nothing that could grow into one (T9, T14).
     */
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3100),

    /**
     * What is running, answered by `/version`. Set by the image build; the
     * first question asked during an incident is which commit is deployed.
     */
    BUILD_SHA: z.string().optional(),
    BUILD_TIME: z.string().optional(),

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

    /**
     * How sign-in codes and alerts reach patients (SP5). `log` writes them to
     * the API log and is used when unset outside production; unset in
     * production, codes cannot be sent. A DLT-registered provider is chosen
     * before the pilot.
     */
    SMS_PROVIDER: z.enum(['log']).optional(),
    /**
     * Where the `log` provider also writes each message, one JSON object per
     * line. The portal's browser tests read the sign-in code from it, having
     * no other way to be the patient's phone (sp5-plan.md, T23).
     */
    SMS_LOG_FILE: z.string().optional(),
    NOTIFICATION_QUEUE_NAME: z.string().optional(),

    /**
     * How this system reaches ABDM (SP8, Decision Z1).
     *
     * `mock` is an in-process stand-in for the gateway that needs no
     * credential, and is what development and CI run against so that the
     * flows can be tested at all. `off` refuses every ABDM operation with a
     * message saying so. Unset means `mock` outside production and `off` in
     * it — the real gateway arrives in Phase 2.
     */
    ABDM_MODE: z.enum(['off', 'mock', 'gateway']).optional(),

    /**
     * Where the gateway is, and who this deployment is to it (SP8, T9).
     *
     * All of these are required together when `ABDM_MODE=gateway`, and the
     * refusal below names the ones that are missing rather than letting the
     * first call fail at three in the morning. `ABDM_HIP_ID` is this
     * facility's id in the Health Facility Registry; `ABDM_CM_ID` is the
     * consent manager this deployment is registered with.
     */
    ABDM_GATEWAY_URL: z.string().url().optional(),
    ABDM_CLIENT_ID: z.string().optional(),
    ABDM_CLIENT_SECRET: z.string().optional(),
    ABDM_HIP_ID: z.string().optional(),
    ABDM_CM_ID: z.string().optional(),

    /**
     * The shared secret an inbound callback must carry.
     *
     * What it is worth is written down in `docs/abdm.md`: it is one of three
     * checks, and the one the specification is least generous about. It is
     * required in production because the alternative is accepting anything
     * that can reach the callback URL.
     */
    ABDM_CALLBACK_SECRET: z.string().optional(),

    /** How long to wait for an answer that arrives as a separate request. */
    ABDM_CALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    /** How far a callback's own timestamp may be from ours before it is refused. */
    ABDM_CALLBACK_SKEW_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
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

    // Plain HTTP to storage somewhere on the internet is a patient's scan in
    // clear on the wire. Plain HTTP to a container on this machine's own
    // network is the local stack, and is allowed so that it can be run.
    if (
      env.NODE_ENV === 'production' &&
      env.STORAGE_ENDPOINT?.startsWith('http:') &&
      !isLocalEndpoint(env.STORAGE_ENDPOINT)
    ) {
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

    // Sixteen characters is enough to refuse a typo; a deployed signing secret
    // is a key, and is generated rather than chosen.
    if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Refusing to start in production with a signing secret shorter than 32 characters',
      });
    }

    // A key rotation that leaves both keys the same has rotated nothing.
    if (env.JWT_ACCESS_SECRET_PREVIOUS === env.JWT_ACCESS_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET_PREVIOUS'],
        message: 'The previous signing secret is the same as the current one',
      });
    }

    if (env.TOTP_ENCRYPTION_KEY_PREVIOUS === env.TOTP_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TOTP_ENCRYPTION_KEY_PREVIOUS'],
        message: 'The previous encryption key is the same as the current one',
      });
    }

    // Uploads are scanned and patients are texted by the worker, through
    // queues. Without Redis both fail quietly, which is the worst way to fail.
    if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'Refusing to start in production without the queue Redis is needed for',
      });
    }

    // The running application holds the unprivileged connection and nothing
    // else. The owner connection belongs to migrations, which run as a job.
    if (env.NODE_ENV === 'production' && env.DATABASE_ADMIN_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_ADMIN_URL'],
        message:
          'Refusing to start in production with the owner connection in the application environment',
      });
    }

    // Long-lived AWS keys in the environment are a credential to steal; the
    // task's own IAM role supplies them instead. A local storage container has
    // no IAM role, so keys are allowed for one — and only one — of those.
    if (
      env.NODE_ENV === 'production' &&
      (env.STORAGE_ACCESS_KEY_ID || env.STORAGE_SECRET_ACCESS_KEY) &&
      !isLocalEndpoint(env.STORAGE_ENDPOINT)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_ACCESS_KEY_ID'],
        message:
          'Refusing to start in production with static storage credentials; use the task role',
      });
    }

    // Without an explicit list the API would answer whatever asked it.
    if (env.NODE_ENV === 'production' && !env.CORS_ORIGINS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'Refusing to start in production without the origins that may call this API',
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

    // A sign-in code written to a log is a code anyone with log access can use.
    if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'log') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMS_PROVIDER'],
        message: 'Refusing to start in production without a real SMS provider',
      });
    }

    // A mock of the national gateway accepts a well-known code and confirms
    // whatever it is asked to. In production that is a way to mark any ABHA
    // verified without the patient being there.
    if (env.NODE_ENV === 'production' && env.ABDM_MODE === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ABDM_MODE'],
        message: 'Refusing to start in production with the ABDM gateway mocked',
      });
    }

    // Half-configured is the worst of the three states: it looks enabled and
    // fails on the first call. Named together, missing together.
    if (env.ABDM_MODE === 'gateway') {
      const missing = (
        [
          ['ABDM_GATEWAY_URL', env.ABDM_GATEWAY_URL],
          ['ABDM_CLIENT_ID', env.ABDM_CLIENT_ID],
          ['ABDM_CLIENT_SECRET', env.ABDM_CLIENT_SECRET],
          ['ABDM_HIP_ID', env.ABDM_HIP_ID],
          ['ABDM_CM_ID', env.ABDM_CM_ID],
        ] as const
      )
        .filter(([, value]) => !value)
        .map(([name]) => name);

      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ABDM_MODE'],
          message: `ABDM_MODE=gateway needs ${missing.join(', ')}`,
        });
      }

      // A patient's national identifier crossing the internet in clear.
      if (
        env.NODE_ENV === 'production' &&
        env.ABDM_GATEWAY_URL?.startsWith('http:') &&
        !isLocalEndpoint(env.ABDM_GATEWAY_URL)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ABDM_GATEWAY_URL'],
          message: 'Refusing to start in production talking to the gateway over plain HTTP',
        });
      }

      // Without it, anything that can reach the callback URL can answer for
      // the national registry.
      if (env.NODE_ENV === 'production' && !env.ABDM_CALLBACK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ABDM_CALLBACK_SECRET'],
          message: 'Refusing to start in production with unauthenticated ABDM callbacks',
        });
      }
    }

    // Worse still on disk, where it outlives the log and nothing rotates it.
    if (env.NODE_ENV === 'production' && env.SMS_LOG_FILE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMS_LOG_FILE'],
        message: 'Refusing to start in production with sign-in codes written to a file',
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
