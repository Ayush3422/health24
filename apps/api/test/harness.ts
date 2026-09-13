import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import type { StaffRole } from '@health24/shared';
import { loadEnv } from '../src/config/load-env';
import { encryptSecret } from '../src/common/crypto';
import { TEST_DATABASE } from './global-setup';
import * as schema from '../src/db/schema';

loadEnv();

/**
 * Boots the real application against the test database.
 *
 * The whole application, not a slice of it: the guards, the validation pipes,
 * the row-level security and the audit trail are exactly what these suites
 * exist to check, and a mocked layer would quietly remove the thing under
 * test.
 */

function pointAtTestDatabase(): void {
  for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL'] as const) {
    const value = process.env[key];
    if (!value) continue;

    const url = new URL(value);
    url.pathname = `/${TEST_DATABASE}`;
    process.env[key] = url.toString();
  }
}

export interface TestContext {
  app: INestApplication;
  http: () => request.Agent;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  pointAtTestDatabase();

  // Imported after the environment is repointed, so the database provider
  // factory reads the test URL.
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.init();

  return {
    app,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
    },
  };
}

/** Direct database access for arranging fixtures and asserting side effects. */
export function testDb() {
  const base = process.env.DATABASE_ADMIN_URL;

  if (!base) throw new Error('DATABASE_ADMIN_URL is not set');

  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE}`;

  const client = postgres(url.toString(), { max: 2, onnotice: () => {} });

  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * A connection as the unprivileged application role.
 *
 * Essential for testing row-level security: the owner connection returned by
 * `testDb` bypasses RLS entirely, so asserting isolation through it would pass
 * no matter how broken the policies were. That is exactly the mistake that
 * made the first RLS migration decorative — it looked correct and enforced
 * nothing.
 */
export function appRoleDb() {
  const base = process.env.DATABASE_URL;

  if (!base) throw new Error('DATABASE_URL is not set');

  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE}`;

  const client = postgres(url.toString(), { max: 2, onnotice: () => {} });

  return { client, close: () => client.end({ timeout: 5 }) };
}

/**
 * Empties every table between tests.
 *
 * `TRUNCATE ... CASCADE` rather than deletes, because the audit trigger
 * forbids DELETE on access_log — correctly, since that table is append-only in
 * the application. Truncation is a DDL operation and bypasses the row trigger,
 * which is exactly why this helper may only ever point at the test database.
 */
export async function resetDatabase(): Promise<void> {
  const { client, close } = testDb();

  try {
    const database = await client`SELECT current_database() AS name`;

    if (database[0]?.name !== TEST_DATABASE) {
      throw new Error(
        `Refusing to truncate ${database[0]?.name} — resetDatabase only runs against ${TEST_DATABASE}`,
      );
    }

    await client.unsafe(`
      TRUNCATE TABLE
        "condition_coding",
        "condition",
        "medication_request",
        "allergy_intolerance",
        "observation",
        "clinical_note",
        "procedure",
        "encounter",
        "consent_artefact",
        "patient_merge_alias",
        "access_log",
        "concept_map_review",
        "concept_map_element",
        "concept_map",
        "concept_designation",
        "concept",
        "code_system",
        "patient_demographic_change",
        "patient_merge_log",
        "patient_merge_candidate",
        "patient_hospital_link",
        "patient_account",
        "patient",
        "session",
        "staff_user",
        "hospital"
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await close();
  }
}

export interface SeededHospital {
  id: string;
  name: string;
  mrnPrefix: string;
}

export interface SeededStaff {
  id: string;
  email: string;
  password: string;
  role: StaffRole;
  hospitalId: string | null;
  totpSecret: string;
}

const FIXTURE_PASSWORD = 'fixture-password-not-real';

/**
 * Creates a hospital with a full set of staff, all with a second factor
 * already enrolled so tests can sign in without walking the enrolment flow.
 */
export async function seedHospital(options: {
  name: string;
  mrnPrefix: string;
  facilityType?: 'ayush' | 'allopathic' | 'integrated';
}): Promise<{ hospital: SeededHospital; staff: Record<string, SeededStaff> }> {
  const { client, db, close } = testDb();

  try {
    const passwordHash = await argon2.hash(FIXTURE_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system_context', 'on', true)`);

      const [hospital] = await tx
        .insert(schema.hospitals)
        .values({
          name: options.name,
          facilityType: options.facilityType ?? 'ayush',
          contactEmail: `contact@${options.mrnPrefix.toLowerCase()}.example.in`,
          contactPhone: '+919812345670',
          mrnPrefix: options.mrnPrefix,
          status: 'active',
        })
        .returning();

      if (!hospital) throw new Error('Failed to seed hospital');

      const staff: Record<string, SeededStaff> = {};

      const definitions: Array<{ key: string; role: StaffRole; systemOfMedicine?: 'ayurveda' }> = [
        { key: 'admin', role: 'hospital_admin' },
        { key: 'clinician', role: 'clinician', systemOfMedicine: 'ayurveda' },
        { key: 'frontDesk', role: 'front_desk' },
      ];

      for (const definition of definitions) {
        const secret = new OTPAuth.Secret({ size: 20 });
        const encrypted = encryptForFixture(secret.base32);
        // Lowercase deliberately: the login schema normalises the address, so a
        // fixture stored with capitals would be an account nobody can sign
        // into. The database now enforces this too — see migration 0003.
        const email = `${definition.key.toLowerCase()}.${options.mrnPrefix.toLowerCase()}@example.in`;

        const [row] = await tx
          .insert(schema.staffUsers)
          .values({
            hospitalId: hospital.id,
            name: `${definition.key} ${options.mrnPrefix}`,
            email,
            role: definition.role,
            systemOfMedicine: definition.systemOfMedicine ?? null,
            status: 'active',
            passwordHash,
            totpSecretEncrypted: encrypted,
            totpEnrolledAt: new Date(),
          })
          .returning();

        if (!row) throw new Error('Failed to seed staff');

        staff[definition.key] = {
          id: row.id,
          email,
          password: FIXTURE_PASSWORD,
          role: definition.role,
          hospitalId: hospital.id,
          totpSecret: secret.base32,
        };
      }

      return {
        hospital: { id: hospital.id, name: hospital.name, mrnPrefix: hospital.mrnPrefix },
        staff,
      };
    });
  } finally {
    await close();
    void client;
  }
}

/** A platform administrator, who belongs to no hospital. */
export async function seedPlatformAdmin(): Promise<SeededStaff> {
  const { db, close } = testDb();

  try {
    const passwordHash = await argon2.hash(FIXTURE_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const secret = new OTPAuth.Secret({ size: 20 });

    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system_context', 'on', true)`);

      const [row] = await tx
        .insert(schema.staffUsers)
        .values({
          hospitalId: null,
          name: 'Platform Admin',
          email: 'platform.admin@example.in',
          role: 'platform_admin',
          status: 'active',
          passwordHash,
          totpSecretEncrypted: encryptForFixture(secret.base32),
          totpEnrolledAt: new Date(),
        })
        .returning();

      if (!row) throw new Error('Failed to seed platform admin');

      return {
        id: row.id,
        email: row.email,
        password: FIXTURE_PASSWORD,
        role: 'platform_admin' as StaffRole,
        hospitalId: null,
        totpSecret: secret.base32,
      };
    });
  } finally {
    await close();
  }
}

/**
 * Uses the application's own encryption, so a fixture's second factor is
 * readable by the running app rather than being a special case the production
 * code path never sees.
 */
function encryptForFixture(base32: string): string {
  const key = process.env.TOTP_ENCRYPTION_KEY;

  if (!key) throw new Error('TOTP_ENCRYPTION_KEY is not set');

  return encryptSecret(base32, key);
}

/**
 * A platform-level account that belongs to no hospital — a platform admin or a
 * terminology curator — with a second factor already enrolled.
 */
export async function seedPlatformUser(options: {
  role: 'platform_admin' | 'terminology_curator';
  email: string;
  name: string;
}): Promise<SeededStaff> {
  const { db, close } = testDb();

  try {
    const passwordHash = await argon2.hash(FIXTURE_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const secret = new OTPAuth.Secret({ size: 20 });

    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system_context', 'on', true)`);

      const [row] = await tx
        .insert(schema.staffUsers)
        .values({
          hospitalId: null,
          name: options.name,
          email: options.email,
          role: options.role,
          status: 'active',
          passwordHash,
          totpSecretEncrypted: encryptForFixture(secret.base32),
          totpEnrolledAt: new Date(),
        })
        .returning();

      if (!row) throw new Error(`Failed to seed ${options.role}`);

      return {
        id: row.id,
        email: row.email,
        password: FIXTURE_PASSWORD,
        role: options.role,
        hospitalId: null,
        totpSecret: secret.base32,
      };
    });
  } finally {
    await close();
  }
}

/** Signs a fixture account in completely and returns its access token. */
export async function signIn(ctx: TestContext, staff: SeededStaff): Promise<string> {
  const login = await ctx
    .http()
    .post('/api/v1/auth/login')
    .send({ email: staff.email, password: staff.password });

  if (login.status !== 200) {
    throw new Error(`Login failed for ${staff.email}: ${login.status} ${login.text}`);
  }

  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(staff.totpSecret),
  });

  const verify = await ctx
    .http()
    .post('/api/v1/auth/mfa/verify')
    .send({ challengeToken: login.body.challengeToken, code: totp.generate() });

  if (verify.status !== 200) {
    throw new Error(`MFA verify failed for ${staff.email}: ${verify.status} ${verify.text}`);
  }

  return verify.body.accessToken as string;
}
