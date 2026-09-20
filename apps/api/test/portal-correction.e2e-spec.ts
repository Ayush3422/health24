import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { LogSmsSender } from '../src/modules/portal/sms';
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
 * Corrections a patient asks for (SP5 Phase 8, Decision N1): the request goes
 * to the hospital the patient chose, whose records staff apply it as an
 * ordinary demographic correction — kept in the patient's change history — or
 * decline it, saying why.
 */
describe('corrections a patient asks for', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;

  let hospitalA: string;
  let hospitalB: string;
  let recordsA: string;
  let recordsB: string;
  let lakshmiId: string;

  const LAKSHMI = { name: 'Lakshmi Correction', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820022101' };
  const CORRECTED_PHONE = '9820022999';

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

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    const a = await seedHospital({ name: 'Sanjeevani Correction Test', mrnPrefix: 'SCR' });
    const b = await seedHospital({ name: 'City General Correction Test', mrnPrefix: 'GCR', facilityType: 'allopathic' });
    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;

    const deskA = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    recordsA = await signIn(ctx, a.staff.records as SeededStaff);
    recordsB = await signIn(ctx, b.staff.records as SeededStaff);

    lakshmiId = (await post('/patients', deskA, LAKSHMI)).body.patient.id;
    expect(
      (await post(`/patients/${lakshmiId}/portal-access`, deskA, { phone: LAKSHMI.phone, identityConfirmed: true }))
        .status,
    ).toBe(201);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('sends the request to the hospital the patient chose, with what the record says now', async () => {
    const bearer = await portalToken();

    const overview = await get('/portal/corrections', bearer);
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.hospitals).toEqual([{ id: hospitalA, name: 'Sanjeevani Correction Test' }]);
    expect(overview.body.current).toMatchObject({
      name: 'Lakshmi Correction',
      date_of_birth: '1968-04-12',
      phone: `+91${LAKSHMI.phone}`,
    });

    const asked = await post('/portal/corrections', bearer, {
      hospitalId: hospitalA,
      field: 'phone',
      requestedValue: CORRECTED_PHONE,
      note: 'I changed my number last month',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({
      field: 'phone',
      status: 'pending',
      currentValue: `+91${LAKSHMI.phone}`,
      requestedValue: CORRECTED_PHONE,
    });

    // Only a hospital the patient is registered at.
    expect(
      (
        await post('/portal/corrections', bearer, {
          hospitalId: hospitalB,
          field: 'name',
          requestedValue: 'Lakshmi C',
        })
      ).status,
    ).toBe(400);
  });

  it('is applied by the hospital’s records staff as an ordinary correction', async () => {
    const queue = await get('/correction-requests', recordsA);
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect(queue.body).toEqual([
      expect.objectContaining({
        field: 'phone',
        status: 'pending',
        patient: expect.objectContaining({ id: lakshmiId, name: 'Lakshmi Correction' }),
      }),
    ]);

    // Another hospital sees nothing of it.
    expect((await get('/correction-requests', recordsB)).body).toEqual([]);

    const requestId = queue.body[0].id;
    const applied = await post(`/correction-requests/${requestId}/apply`, recordsA);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ status: 'applied', resolvedBy: { name: expect.any(String) } });

    expect((await get(`/patients/${lakshmiId}`, recordsA)).body.phone).toBe(`+91${CORRECTED_PHONE}`);

    const [change] = await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return tx<Array<{ field: string; new_value: string; reason: string }>>`
        SELECT field, new_value, reason FROM patient_demographic_change
         WHERE patient_id = ${lakshmiId} ORDER BY changed_at DESC LIMIT 1
      `;
    });
    expect(change).toMatchObject({ field: 'phone', new_value: `+91${CORRECTED_PHONE}` });
    expect(change!.reason).toContain('portal');

    expect((await post(`/correction-requests/${requestId}/apply`, recordsA)).status).toBe(409);
  });

  it('is declined with a reason, and the patient sees what happened', async () => {
    const bearer = await portalToken();

    const asked = await post('/portal/corrections', bearer, {
      hospitalId: hospitalA,
      field: 'gender',
      requestedValue: 'not-a-gender',
    });
    expect(asked.status).toBe(201);
    const requestId = asked.body.id;

    // A value the record cannot take is refused rather than forced in.
    expect((await post(`/correction-requests/${requestId}/apply`, recordsA)).status).toBe(400);
    expect((await post(`/correction-requests/${requestId}/decline`, recordsA)).status).toBe(400);

    const declined = await post(`/correction-requests/${requestId}/decline`, recordsA, {
      note: 'Please bring an identity document to the desk',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body).toMatchObject({ status: 'declined' });

    const mine = await get('/portal/corrections', bearer);
    expect(mine.body.requests).toEqual([
      expect.objectContaining({
        id: requestId,
        status: 'declined',
        resolutionNote: 'Please bring an identity document to the desk',
      }),
      expect.objectContaining({ field: 'phone', status: 'applied' }),
    ]);
  });
});
