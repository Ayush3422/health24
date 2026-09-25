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
 * What an operator can ask this process (sp7-plan.md, T8, T9, DF6).
 *
 * Liveness, readiness and version are three different questions, and the
 * metrics are the fourth. All four are public, and none of them may say
 * anything about a patient — a probe is read by a load balancer and a metric
 * is kept for a year on a dashboard with none of the record's protections.
 */
describe('health, readiness, version and metrics', () => {
  let ctx: TestContext;
  let token: string;
  let patientId: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const seeded = await seedHospital({ name: 'Health Probe Hospital', mrnPrefix: 'HPH' });
    token = await signIn(ctx, seeded.staff.frontDesk as SeededStaff);

    patientId = (
      await ctx
        .http()
        .post('/api/v1/patients')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Probe Patient', gender: 'female', dateOfBirth: '1980-01-01' })
    ).body.patient.id as string;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('says it is alive without asking anything else', async () => {
    const response = await ctx.http().get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Liveness must not depend on the database: restarting the process would
    // not fix the database, and would lose what is in flight.
    expect(response.body.database).toBeUndefined();
  });

  it('says whether it can actually serve, dependency by dependency', async () => {
    const response = await ctx.http().get('/ready');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.ready).toBe(true);

    const checks = response.body.checks as Record<string, { state: string; ms: number }>;
    expect(Object.keys(checks).sort()).toEqual(['database', 'migrations', 'redis', 'storage']);
    expect(checks.database!.state).toBe('up');
    expect(checks.migrations!.state).toBe('up');
    expect(Object.values(checks).every((check) => typeof check.ms === 'number')).toBe(true);
  });

  it('says what is running', async () => {
    const response = await ctx.http().get('/version');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: expect.any(String),
      commit: expect.any(String),
      builtAt: expect.any(String),
      environment: expect.any(String),
    });
  });

  it('counts requests by route and status, and names no patient', async () => {
    await ctx.http().get(`/api/v1/patients/${patientId}`).set('Authorization', `Bearer ${token}`);
    await ctx.http().get('/api/v1/patients/not-a-uuid').set('Authorization', `Bearer ${token}`);

    const response = await ctx.http().get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    const body = response.text;

    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('# TYPE http_request_duration_seconds histogram');

    // The route is its pattern, which is what keeps the number of time series
    // bounded — and, here, keeps the patient's id off the dashboard.
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/api\/v1\/patients\/:id"[^}]*\}/);
    expect(body).toContain('status="2xx"');
    expect(body).not.toContain(patientId);
    expect(body).not.toContain('Probe Patient');
  });
});
