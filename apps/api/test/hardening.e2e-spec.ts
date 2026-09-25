import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * The edge: what a browser is told, what is refused, and how fast anybody may
 * ask (sp7-plan.md, T10–T13).
 *
 * These are the controls nobody notices until they are missing, and the ones
 * most likely to be quietly removed to make something work — so each is
 * asserted against the running application rather than against the
 * configuration that is supposed to produce it.
 */
describe('the edge', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const seeded = await seedHospital({ name: 'Hardening Test', mrnPrefix: 'HRD' });
    token = await signIn(ctx, seeded.staff.frontDesk as SeededStaff);
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  describe('security headers', () => {
    it('are on every response, including the ones that fail', async () => {
      const responses = await Promise.all([
        ctx.http().get('/health'),
        ctx.http().get('/api/v1/patients').set('Authorization', `Bearer ${token}`),
        ctx.http().get('/api/v1/patients'),
        ctx.http().get('/api/v1/nothing-here'),
      ]);

      for (const response of responses) {
        expect(response.headers['content-security-policy']).toContain("default-src 'none'");
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
      }
    });

    it('do not say what the API is built on', async () => {
      const response = await ctx.http().get('/health');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('the size of what may be sent', () => {
    it('refuses a body far larger than any clinical note', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/patients')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Oversized Patient',
          gender: 'female',
          dateOfBirth: '1980-01-01',
          // Half a megabyte of it, which no screen can produce.
          notes: 'x'.repeat(512 * 1024),
        });

      // 413 from the parser, or 400 from validation if it gets that far —
      // either way it does not reach a handler with half a megabyte in hand.
      expect([400, 413]).toContain(response.status);
    });

    it('takes an ordinary body without complaint', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/patients')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Ordinary Patient', gender: 'female', dateOfBirth: '1980-01-01' });

      expect(response.status).toBe(201);
    });
  });

  describe('how often anybody may ask', () => {
    it('refuses a flood at the sign-in door', async () => {
      // Sixty attempts a minute from one address, because a hospital is behind
      // one NAT and a shift changes together. What stops a password being
      // guessed is not this but the per-account lockout in AuthService, which
      // is unaffected by how many colleagues are signing in at the same time.
      const attempts = await Promise.all(
        Array.from({ length: 70 }, () =>
          ctx
            .http()
            .post('/api/v1/auth/login')
            .send({ email: 'nobody@example.in', password: 'not-the-password' }),
        ),
      );

      const refused = attempts.filter((response) => response.status === 429);
      expect(refused.length).toBeGreaterThan(0);

      // The refusal says to come back later, and nothing about the account.
      const said = JSON.stringify(refused[0]!.body).toLowerCase();
      expect(said).not.toContain('password');
      expect(said).not.toContain('nobody@example.in');
    });

    it('counts each route separately, so a flood at one door does not shut another', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          ctx
            .http()
            .get('/api/v1/patients?q=Ordinary')
            .set('Authorization', `Bearer ${token}`),
        ),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
    });
  });

  describe('cross-origin access', () => {
    it('answers an allowed origin, without asking the browser for credentials', async () => {
      const response = await ctx
        .http()
        .get('/health')
        .set('Origin', 'http://localhost:5173');

      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      // No cookies are used, so nothing asks the browser to attach any.
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('does not offer itself to an origin nobody listed', async () => {
      const response = await ctx
        .http()
        .get('/health')
        .set('Origin', 'https://evil.example.com');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
