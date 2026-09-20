import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { LogSmsSender } from '../src/modules/portal/sms';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  seedPlatformUser,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * Erasure under the DPDP Act (SP5 Phase 8, Decision N1): the patient asks;
 * Health24's data-protection officer decides; clinical records are kept as law
 * requires, while the portal account, the emergency card, consents in force
 * and the contact details held for the patient are ended — and the patient is
 * told what happened.
 */
describe('erasure requests', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;

  let hospitalB: string;
  let officerToken: string;
  let recordsToken: string;
  let lakshmiId: string;
  let requestId: string;

  const LAKSHMI = { name: 'Lakshmi Erasure', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820011101' };

  const post = (path: string, bearer: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (bearer ? request.set('Authorization', `Bearer ${bearer}`) : request).send(body);
  };

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  async function portalToken(): Promise<string> {
    await owner`DELETE FROM otp_challenge`;
    await post('/portal/auth/otp', null, { phone: LAKSHMI.phone });
    const code = sms.lastTo(`+91${LAKSHMI.phone}`)?.body.slice(0, 6);
    const verified = await post('/portal/auth/verify', null, { phone: LAKSHMI.phone, code });
    const session = await post('/portal/auth/session', null, {
      selectionToken: verified.body.selectionToken,
      patientId: lakshmiId,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    return session.body.accessToken as string;
  }

  async function asSystem<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    const a = await seedHospital({ name: 'Sanjeevani Erasure Test', mrnPrefix: 'SER' });
    const b = await seedHospital({ name: 'City General Erasure Test', mrnPrefix: 'GER', facilityType: 'allopathic' });
    hospitalB = b.hospital.id;

    const deskA = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    const deskB = await signIn(ctx, b.staff.frontDesk as SeededStaff);
    recordsToken = await signIn(ctx, a.staff.records as SeededStaff);
    officerToken = await signIn(
      ctx,
      await seedPlatformUser({
        role: 'data_protection_officer',
        email: 'officer.erasure@example.in',
        name: 'Data Protection Officer',
      }),
    );

    lakshmiId = (await post('/patients', deskA, LAKSHMI)).body.patient.id;
    expect((await post('/patients', deskB, LAKSHMI)).body.linkedExisting).toBe(true);
    expect(
      (await post(`/patients/${lakshmiId}/portal-access`, deskA, { phone: LAKSHMI.phone, identityConfirmed: true }))
        .status,
    ).toBe(201);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await asSystem(
      (tx) => tx`
        UPDATE patient SET emergency_contact_name = 'Ravi Erasure', emergency_contact_phone = '+919820011199'
         WHERE id = ${lakshmiId}
      `,
    );

    // Something to end: a consent in force and an emergency card.
    const bearer = await portalToken();
    expect(
      (await post('/portal/consents', bearer, { hospitalId: hospitalB, dataCategories: ['allergies'], validForDays: 90 }))
        .status,
    ).toBe(201);
    expect((await post('/portal/emergency-card', bearer, { fields: ['blood_group'] })).status).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('is asked for in the portal, once at a time', async () => {
    const bearer = await portalToken();

    const asked = await post('/portal/erasure-requests', bearer, {
      reason: 'I no longer want Health24 to hold my details',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ status: 'pending', outcome: null });
    requestId = asked.body.id;

    expect((await post('/portal/erasure-requests', bearer)).status).toBe(409);
    expect((await get('/portal/erasure-requests', bearer)).body).toEqual([
      expect.objectContaining({ id: requestId, status: 'pending' }),
    ]);
  });

  it('is seen by the data-protection officer, and by nobody at a hospital', async () => {
    const queue = await get('/erasure-requests', officerToken);
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect(queue.body).toEqual([
      expect.objectContaining({
        id: requestId,
        status: 'pending',
        requestedByPhone: expect.stringContaining('•'),
      }),
    ]);
    // The officer never sees the record a request is about.
    expect(JSON.stringify(queue.body)).not.toContain('Lakshmi');

    expect((await get('/erasure-requests', recordsToken)).status).toBe(403);
  });

  it('ends the account, the card, the sharing and the contact details — and keeps the record', async () => {
    // Held from before the decision, to show that access stops at once.
    const bearer = await portalToken();

    const decided = await post(`/erasure-requests/${requestId}/decide`, officerToken, {
      outcome: 'partly_erased',
      retentionNote:
        'Clinical records are kept for three years, as the Clinical Establishments Rules require.',
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.erasedSummary).toContain('Portal access ended: 1');
    expect(decided.body.erasedSummary).toContain('emergency cards turned off: 1');
    expect(decided.body.erasedSummary).toContain('consents in force revoked: 1');

    const state = await asSystem(async (tx) => {
      const [patient] = await tx<Array<{ phone: string | null; emergency_contact_name: string | null }>>`
        SELECT phone, emergency_contact_name FROM patient WHERE id = ${lakshmiId}
      `;
      const [access] = await tx<Array<{ revoked_at: string | null; revoked_reason: string | null }>>`
        SELECT revoked_at::text, revoked_reason FROM patient_portal_access WHERE patient_id = ${lakshmiId}
      `;
      const [card] = await tx<Array<{ revoked_at: string | null }>>`
        SELECT revoked_at::text FROM emergency_card WHERE patient_id = ${lakshmiId}
      `;
      const [consent] = await tx<Array<{ status: string }>>`
        SELECT status::text FROM consent_artefact WHERE patient_id = ${lakshmiId}
      `;
      const [account] = await tx<Array<{ status: string }>>`
        SELECT status::text FROM patient_account WHERE phone = ${`+91${LAKSHMI.phone}`}
      `;
      const [change] = await tx<Array<{ field: string; reason: string }>>`
        SELECT field, reason FROM patient_demographic_change
         WHERE patient_id = ${lakshmiId} ORDER BY changed_at DESC LIMIT 1
      `;
      const [visits] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM patient WHERE id = ${lakshmiId}
      `;

      return { patient: patient!, access: access!, card: card!, consent: consent!, account: account!, change: change!, visits: visits! };
    });

    expect(state.patient).toEqual({ phone: null, emergency_contact_name: null });
    expect(state.access.revoked_at).toBeTruthy();
    expect(state.access.revoked_reason).toContain('DPDP');
    expect(state.card.revoked_at).toBeTruthy();
    expect(state.consent.status).toBe('revoked');
    expect(state.account.status).toBe('deactivated');
    expect(state.change.reason).toContain('DPDP');
    // The patient's record itself is still there: erasure does not delete it.
    expect(state.visits.count).toBe(1);

    const message = sms.lastTo(`+91${LAKSHMI.phone}`);
    expect(message).toMatchObject({ template: 'erasure' });
    expect(message!.body).toContain('in part');

    // The portal is closed to the account that asked, at once.
    expect((await get('/portal/summary', bearer)).status).toBe(401);

    expect((await post(`/erasure-requests/${requestId}/decide`, officerToken, {
      outcome: 'refused',
      retentionNote: 'Nothing further to decide, as this was already decided.',
    })).status).toBe(409);
  });
});
