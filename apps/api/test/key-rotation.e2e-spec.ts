import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import * as OTPAuth from 'otpauth';
import { rewrapAll } from '../src/db/rewrap-secrets';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * Rotating a key without locking anybody out (sp7-plan.md, T4).
 *
 * A key that cannot be rotated in a live system is a key that is never
 * rotated, which is how a leaked secret stays in use for years. This walks the
 * procedure in `docs/runbooks/key-rotation.md` as the runbook describes it,
 * and asserts the two things that matter at each step: that people can still
 * sign in, and that the old key stops working once it is withdrawn.
 */
describe('a key rotation', () => {
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let clinician: SeededStaff;
  let hospitalId: string;

  const oldJwtSecret = process.env.JWT_ACCESS_SECRET!;
  const oldTotpKey = process.env.TOTP_ENCRYPTION_KEY!;
  const newJwtSecret = crypto.randomBytes(32).toString('base64url');
  const newTotpKey = crypto.randomBytes(32).toString('base64url');

  /**
   * A fresh application, reading the environment as it stands now.
   *
   * `ConfigModule.forRoot` validates the environment when the module file is
   * first imported, so a process that has already booted keeps the keys it
   * booted with — which is correct in production, where a rotation is a
   * redeploy, and is what this has to reproduce here.
   */
  async function bootWithCurrentEnvironment(): Promise<TestContext> {
    vi.resetModules();
    return createTestApp();
  }

  /** Signs in through the API the way the apps do: password, then a code. */
  async function signInThrough(ctx: TestContext, staff: SeededStaff): Promise<number> {
    const login = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: staff.email, password: staff.password });

    if (login.status !== 200) return login.status;

    const code = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(staff.totpSecret),
    }).generate();

    const verified = await ctx
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code });

    return verified.status;
  }

  const readsRecord = (ctx: TestContext, token: string) =>
    ctx.http().get('/api/v1/patients?q=Rotation').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await resetDatabase();

    const seeded = await seedHospital({ name: 'Rotation Test Hospital', mrnPrefix: 'RKT' });
    hospitalId = seeded.hospital.id;
    clinician = seeded.staff.clinician as SeededStaff;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  }, 120_000);

  afterAll(async () => {
    process.env.JWT_ACCESS_SECRET = oldJwtSecret;
    process.env.TOTP_ENCRYPTION_KEY = oldTotpKey;
    delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    delete process.env.TOTP_ENCRYPTION_KEY_PREVIOUS;

    await closeOwner?.();
  });

  it('keeps everyone signed in while both keys are in force, and moves the rows across', async () => {
    // Before: an ordinary day, and a token issued under the key in force.
    const before = await bootWithCurrentEnvironment();
    const token = await signIn(before, clinician);
    expect((await readsRecord(before, token)).status).toBe(200);
    await before.close();

    // The rotation: the new key in force, the old one still accepted.
    process.env.JWT_ACCESS_SECRET = newJwtSecret;
    process.env.JWT_ACCESS_SECRET_PREVIOUS = oldJwtSecret;
    process.env.TOTP_ENCRYPTION_KEY = newTotpKey;
    process.env.TOTP_ENCRYPTION_KEY_PREVIOUS = oldTotpKey;

    const during = await bootWithCurrentEnvironment();

    // Yesterday's token is still honoured, so nobody is thrown out mid-shift.
    expect((await readsRecord(during, token)).status).toBe(200);

    // And the second factor still opens the door, though its secret is on disk
    // under the key that has just been replaced.
    expect(await signInThrough(during, clinician)).toBe(200);
    await during.close();

    // The rewrite that the runbook runs next.
    const counted = await rewrapAll(owner, [newTotpKey, oldTotpKey]);
    expect(counted['staff_user']!.rewritten).toBeGreaterThan(0);
    expect(counted['staff_user']!.unreadable).toBe(0);
    expect(counted['emergency_card']!.unreadable).toBe(0);

    // Running it twice moves nothing: every row is already current.
    expect((await rewrapAll(owner, [newTotpKey, oldTotpKey]))['staff_user']!.rewritten).toBe(0);
  }, 180_000);

  it('works on the new key alone once the old one is withdrawn', async () => {
    delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    delete process.env.TOTP_ENCRYPTION_KEY_PREVIOUS;

    const after = await bootWithCurrentEnvironment();

    // The second factor reads under the new key, because the rows moved.
    expect(await signInThrough(after, clinician)).toBe(200);

    // A token signed under the withdrawn secret is no longer accepted — which
    // is the point of withdrawing it.
    const stale = await createStaleToken();
    expect((await readsRecord(after, stale)).status).toBe(401);

    await after.close();
  }, 120_000);

  /** A token signed with the old secret, as one issued before the rotation was. */
  async function createStaleToken(): Promise<string> {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: oldJwtSecret });

    const [session] = await owner<Array<{ id: string }>>`
      SELECT id FROM session
       WHERE staff_user_id = ${clinician.id} AND revoked_at IS NULL
    ORDER BY issued_at DESC LIMIT 1
    `;

    return jwt.signAsync(
      { sub: clinician.id, sid: session!.id, role: clinician.role, hid: hospitalId },
      { expiresIn: '15m', audience: 'health24-staff' },
    );
  }
});
