import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  MOCK_GATEWAY_CODE,
  MockGatewayServer,
} from '../src/modules/abdm/gateway/mock-gateway';
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
 * The transport, proved by using it (sp8-plan.md, T6, T7, T8).
 *
 * `ABDM_MODE=gateway` here, pointed at a mock gateway that behaves the way
 * the real one does: it hands out a session, refuses a call that does not
 * carry it, answers 202 saying nothing, and then calls back on its own
 * connection quoting the request id. So this suite exercises the session
 * cache, the correlation registry, the callback endpoint and its
 * authentication, in the arrangement they are deployed in — over real HTTP,
 * in both directions.
 *
 * It is also the answer to "how is any of this tested without a sandbox
 * account" (Decision Z1): the wire is exercised, the credentials are
 * fictional, and reconciling the mock's behaviour with ABDM's own is T38.
 */
describe('the ABDM gateway transport', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let gateway: MockGatewayServer;
  let frontDesk: SeededStaff;
  let token: string;

  const CALLBACK_SECRET = 'a-shared-secret-for-callbacks';
  const before: Record<string, string | undefined> = {};

  const post = (path: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  const get = (path: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  /** A patient at the fixture hospital, with nothing claimed about them. */
  async function register(name: string): Promise<string> {
    const response = await post('/patients', {
      name,
      gender: 'female',
      dateOfBirth: '1990-01-01',
      forceCreate: true,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { patient: { id: string } }).patient.id;
  }

  beforeAll(async () => {
    await resetDatabase();

    const seeded = await seedHospital({ name: 'Gateway Test Clinic', mrnPrefix: 'GTC' });
    frontDesk = seeded.staff.frontDesk!;

    gateway = new MockGatewayServer({
      clientId: 'health24-under-test',
      clientSecret: 'not-a-real-client-secret',
      callbackSecret: CALLBACK_SECRET,
    });

    await gateway.start();
    closers.push(() => gateway.stop());

    // Set before the application module is imported: the configuration
    // schema runs at import time, so a value set afterwards is a value the
    // application never sees.
    for (const [key, value] of Object.entries({
      ABDM_MODE: 'gateway',
      ABDM_GATEWAY_URL: gateway.url,
      ABDM_CLIENT_ID: 'health24-under-test',
      ABDM_CLIENT_SECRET: 'not-a-real-client-secret',
      ABDM_HIP_ID: 'HFR-UNDER-TEST-0001',
      ABDM_CM_ID: 'sbx',
      ABDM_CALLBACK_SECRET: CALLBACK_SECRET,
      // Short, so the suite can afford to prove the timeout path.
      ABDM_CALL_TIMEOUT_MS: '3000',
    })) {
      before[key] = process.env[key];
      process.env[key] = value;
    }

    ctx = await createTestApp();
    closers.push(ctx.close);

    // A real port, because the point of this suite is that the gateway
    // reaches back over HTTP rather than through a function call.
    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as AddressInfo;
    gateway.callbackBaseUrl = `http://127.0.0.1:${String(address.port)}`;

    token = await signIn(ctx, frontDesk);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);
  });

  afterAll(async () => {
    for (const close of closers) await close();

    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('verifies an ABHA over the wire, answer and all', async () => {
    const patientId = await register('Gateway Lakshmi');

    const started = await post(`/patients/${patientId}/abha/verification`, {
      abhaAddress: 'gateway.lakshmi@abdm',
      method: 'mobile_otp',
    });

    expect(started.status, JSON.stringify(started.body)).toBe(201);
    // The masked destination came from the gateway, not from this system —
    // which has never seen the patient's registered mobile.
    expect(started.body).toMatchObject({ sentTo: 'XXXXXXXX99' });
    expect((started.body as { transactionId: string }).transactionId).toBeTruthy();

    const confirmed = await post(`/patients/${patientId}/abha/verification/confirm`, {
      transactionId: (started.body as { transactionId: string }).transactionId,
      code: MOCK_GATEWAY_CODE,
    });

    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(confirmed.body).toMatchObject({
      abhaAddress: 'gateway.lakshmi@abdm',
      verified: true,
      verificationMethod: 'mobile_otp',
    });

    const [row] = await owner<Array<{ abha_address_verified_at: Date | null }>>`
      SELECT abha_address_verified_at FROM patient WHERE id = ${patientId}
    `;

    expect(row?.abha_address_verified_at).not.toBeNull();

    // Two operations, each correlated to its own call.
    const operations = gateway.sent.map((entry) => entry.operation);
    expect(operations).toContain('abha.verify.init');
    expect(operations).toContain('abha.verify.confirm');
    expect(new Set(gateway.sent.map((entry) => entry.correlation)).size).toBe(
      gateway.sent.length,
    );
  });

  it('pays for one session and reuses it', () => {
    // Several calls have now been made. A token per call would be two round
    // trips for every operation and a rate limit reached by doing nothing
    // wrong.
    expect(gateway.sessionsIssued).toBe(1);
  });

  it('puts the registry’s refusal in front of the person who typed the code', async () => {
    const patientId = await register('Gateway Wrong Code');

    const started = await post(`/patients/${patientId}/abha/verification`, {
      abhaNumber: '31313131313131',
      method: 'mobile_otp',
    });

    const refused = await post(`/patients/${patientId}/abha/verification/confirm`, {
      transactionId: (started.body as { transactionId: string }).transactionId,
      code: '111111',
    });

    expect(refused.status).toBe(401);
    expect(JSON.stringify(refused.body)).toMatch(/not correct/i);

    const identity = await get(`/patients/${patientId}/abha`);
    expect(identity.body).toMatchObject({ verified: false });
  });

  /**
   * The failure that never happens on a developer's machine and always
   * happens eventually: the call is accepted and the answer never comes.
   */
  it('gives up on a gateway that never answers, and blames nobody', async () => {
    const patientId = await register('Gateway Silence');

    gateway.silent = true;

    try {
      const started = await post(`/patients/${patientId}/abha/verification`, {
        abhaNumber: '41414141414141',
        method: 'mobile_otp',
      });

      expect(started.status).toBe(504);
      expect(JSON.stringify(started.body)).toMatch(/did not answer|Nothing was recorded/i);
    } finally {
      gateway.silent = false;
    }
  }, 30_000);

  describe('the callback endpoint', () => {
    const callback = (body: Record<string, unknown>, secret?: string) => {
      const request = ctx.http().post('/api/v1/abdm/callbacks/abha.verify.init');
      return secret === undefined
        ? request.send(body)
        : request.set('x-abdm-callback-secret', secret).send(body);
    };

    it('refuses an answer to a question nobody asked', async () => {
      const response = await callback(
        {
          requestId: 'ffffffff-1111-4444-8888-aaaaaaaaaaaa',
          timestamp: new Date().toISOString(),
          resp: { requestId: 'ffffffff-2222-4444-8888-bbbbbbbbbbbb' },
          payload: { transactionId: 'injected' },
        },
        CALLBACK_SECRET,
      );

      expect(response.status).toBe(401);
    });

    it('refuses a caller that cannot prove who it is', async () => {
      const response = await callback({
        requestId: 'ffffffff-3333-4444-8888-cccccccccccc',
        timestamp: new Date().toISOString(),
        resp: { requestId: 'ffffffff-4444-4444-8888-dddddddddddd' },
      });

      expect(response.status).toBe(401);
    });

    it('says nothing about which check it failed', async () => {
      const response = await callback({ timestamp: new Date().toISOString() }, 'wrong-secret');

      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(/secret|correlation|timestamp/i);
    });

    it('needs no staff sign-in, which is the one thing it is open about', async () => {
      // Unauthenticated in the staff sense, and still refused — the
      // authorisation here is the correlation, not a session.
      const response = await ctx
        .http()
        .post('/api/v1/abdm/callbacks/abha.verify.init')
        .set('x-abdm-callback-secret', CALLBACK_SECRET)
        .send({ timestamp: new Date().toISOString() });

      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(/token|sign in/i);
    });
  });
});
