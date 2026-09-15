import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { LogSmsSender } from '../src/modules/portal/sms';
import {
  appRoleDb,
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

type TimelineItem = { kind: string; hospital: { isOwn: boolean } };

/**
 * Consent from the portal (SP5 Phase 4, Decision K1): the patient shares their
 * record from other hospitals with one they are registered at, sees it take
 * effect, and revokes it — or a consent recorded at the desk — at once.
 */
describe('patient portal consent', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;

  let hospitalA: string;
  let hospitalB: string;
  let hospitalC: string;
  let clinicianBToken: string;
  let frontDeskBToken: string;
  let frontDeskBId: string;
  let frontDeskBName: string;

  let lakshmiId: string;
  let otherId: string;
  let accountId: string;
  let portalConsentId: string;

  const LAKSHMI = { name: 'Lakshmi Consent', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820088001' };
  const OTHER = { name: 'Other Consent', gender: 'male', dateOfBirth: '1990-01-01', phone: '9820088002' };

  const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (token ? request.set('Authorization', `Bearer ${token}`) : request).send(body);
  };

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  async function portalToken(phone: string, patientId: string): Promise<string> {
    await owner`DELETE FROM otp_challenge`;
    await post('/portal/auth/otp', null, { phone });
    const code = sms.lastTo(`+91${phone}`)?.body.slice(0, 6);
    const verified = await post('/portal/auth/verify', null, { phone, code });
    const session = await post('/portal/auth/session', null, {
      selectionToken: verified.body.selectionToken,
      patientId,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    return session.body.accessToken as string;
  }

  /** What City General's clinician sees of Lakshmi's record from elsewhere. */
  async function sharedWithB(): Promise<string[]> {
    const response = await get(`/patients/${lakshmiId}/timeline`, clinicianBToken);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body.items as TimelineItem[])
      .filter((item) => !item.hospital.isOwn)
      .map((item) => item.kind)
      .sort();
  }

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    const a = await seedHospital({ name: 'Sanjeevani Consent Test', mrnPrefix: 'SCT' });
    const b = await seedHospital({ name: 'City General Consent Test', mrnPrefix: 'GCT', facilityType: 'allopathic' });
    const c = await seedHospital({ name: 'Unrelated Consent Test', mrnPrefix: 'UCT', facilityType: 'allopathic' });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;
    hospitalC = c.hospital.id;
    frontDeskBId = (b.staff.frontDesk as SeededStaff).id;

    const deskA = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    frontDeskBToken = await signIn(ctx, b.staff.frontDesk as SeededStaff);
    clinicianBToken = await signIn(ctx, b.staff.clinician as SeededStaff);
    const clinicianA = a.staff.clinician as SeededStaff;

    lakshmiId = (await post('/patients', deskA, LAKSHMI)).body.patient.id;
    expect((await post('/patients', frontDeskBToken, LAKSHMI)).body.linkedExisting).toBe(true);
    otherId = (await post('/patients', deskA, OTHER)).body.patient.id;

    for (const [patientId, phone] of [
      [lakshmiId, LAKSHMI.phone],
      [otherId, OTHER.phone],
    ] as const) {
      expect(
        (await post(`/patients/${patientId}/portal-access`, deskA, { phone, identityConfirmed: true })).status,
      ).toBe(201);
    }

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    // A visit and an allergy at Sanjeevani: what City General may come to see.
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [visit] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id, status, started_at, ended_at)
        VALUES (${lakshmiId}, ${hospitalA}, 'outpatient', 'ayurveda', ${clinicianA.id}, ${clinicianA.id}, 'finished',
                now() - interval '40 days', now() - interval '40 days' + interval '20 minutes')
        RETURNING id
      `;
      await tx`
        INSERT INTO allergy_intolerance (patient_id, hospital_id, encounter_id, substance, category, criticality, reaction, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${hospitalA}, ${visit!.id}, 'Penicillin', 'medication', 'high', 'Hives', ${clinicianA.id}, ${clinicianA.id})
      `;

      const [desk] = await tx<Array<{ name: string }>>`SELECT name FROM staff_user WHERE id = ${frontDeskBId}`;
      frontDeskBName = desk!.name;

      const [account] = await tx<Array<{ id: string }>>`
        SELECT id::text FROM patient_account WHERE phone = ${`+91${LAKSHMI.phone}`}
      `;
      accountId = account!.id;
    });
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('lets the patient share with a hospital they are registered at, and that hospital sees exactly that', async () => {
    expect(await sharedWithB()).toEqual([]);

    const token = await portalToken(LAKSHMI.phone, lakshmiId);

    const before = await get('/portal/consents', token);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toEqual({
      hospitals: [
        { id: hospitalA, name: 'Sanjeevani Consent Test' },
        { id: hospitalB, name: 'City General Consent Test' },
      ],
      consents: [],
    });

    const granted = await post('/portal/consents', token, {
      hospitalId: hospitalB,
      dataCategories: ['allergies'],
      validForDays: 180,
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(granted.body).toMatchObject({
      hospital: { id: hospitalB, name: 'City General Consent Test' },
      dataCategories: ['allergies'],
      status: 'active',
      captureMethod: 'patient_portal',
      recordedBy: { kind: 'patient', you: true },
      revokedBy: null,
    });
    portalConsentId = granted.body.id;

    // Allergies, and not the visit.
    expect(await sharedWithB()).toEqual(['allergy']);

    // The hospital's sharing screen says the patient granted it.
    const atB = await get(`/patients/${lakshmiId}/consents`, frontDeskBToken);
    expect(atB.body).toEqual([
      expect.objectContaining({
        id: portalConsentId,
        captureMethod: 'patient_portal',
        recordedBy: null,
        revokedInPortal: false,
      }),
    ]);

    const [audited] = await owner<Array<{ actor_type: string; action: string }>>`
      SELECT actor_type::text, action::text FROM access_log
       WHERE resource_type = 'consent_artefact' AND resource_id = ${portalConsentId}
    `;
    expect(audited).toEqual({ actor_type: 'patient', action: 'create' });
  });

  it('refuses a hospital the patient is not registered at, and a consent that says nothing', async () => {
    const token = await portalToken(LAKSHMI.phone, lakshmiId);

    for (const body of [
      { hospitalId: hospitalC, dataCategories: ['allergies'], validForDays: 30 },
      { hospitalId: hospitalB, dataCategories: [], validForDays: 30 },
      { hospitalId: hospitalB, dataCategories: ['allergies'], validForDays: 400 },
      {
        hospitalId: hospitalB,
        dataCategories: ['allergies'],
        validForDays: 30,
        dateRangeFrom: '2026-05-01',
        dateRangeTo: '2026-01-01',
      },
    ]) {
      expect((await post('/portal/consents', token, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('revokes with immediate effect, and keeps the history', async () => {
    const token = await portalToken(LAKSHMI.phone, lakshmiId);

    const revoked = await post(`/portal/consents/${portalConsentId}/revoke`, token);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({
      status: 'revoked',
      revokedBy: { kind: 'patient', you: true },
      revocationReason: 'Revoked by the patient in the portal',
    });

    expect(await sharedWithB()).toEqual([]);
    expect((await post(`/portal/consents/${portalConsentId}/revoke`, token)).status).toBe(409);

    const list = await get('/portal/consents', token);
    expect(list.body.consents).toEqual([
      expect.objectContaining({ id: portalConsentId, status: 'revoked' }),
    ]);
  });

  it('lets the patient revoke consent recorded at the desk, but not end emergency access', async () => {
    const desk = await post(`/patients/${lakshmiId}/consents`, frontDeskBToken, {
      dataCategories: ['encounters'],
      validForDays: 30,
      captureMethod: 'signed_form',
    });
    expect(desk.status, JSON.stringify(desk.body)).toBe(201);

    const emergency = await post(`/patients/${lakshmiId}/break-glass`, clinicianBToken, {
      reason: 'Collapsed in the waiting area; needs allergy history now',
      hours: 1,
    });
    expect(emergency.status, JSON.stringify(emergency.body)).toBe(201);

    const token = await portalToken(LAKSHMI.phone, lakshmiId);

    const list = await get('/portal/consents', token);
    expect(list.body.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: desk.body.id,
          captureMethod: 'signed_form',
          recordedBy: { kind: 'staff', name: frontDeskBName },
        }),
        expect.objectContaining({ id: emergency.body.id, captureMethod: 'break_glass' }),
      ]),
    );

    const revoked = await post(`/portal/consents/${desk.body.id}/revoke`, token, {
      reason: 'I no longer want to share my visits',
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const atB = await get(`/patients/${lakshmiId}/consents`, frontDeskBToken);
    expect(atB.body.find((consent: { id: string }) => consent.id === desk.body.id)).toMatchObject({
      status: 'revoked',
      revokedBy: null,
      revokedInPortal: true,
      revocationReason: 'I no longer want to share my visits',
    });

    expect((await post(`/portal/consents/${emergency.body.id}/revoke`, token)).status).toBe(403);
  });

  it('keeps one patient out of another’s consents', async () => {
    const token = await portalToken(OTHER.phone, otherId);

    expect((await get('/portal/consents', token)).body.consents).toEqual([]);
    expect((await post(`/portal/consents/${portalConsentId}/revoke`, token)).status).toBe(404);
    expect(
      (
        await post('/portal/consents', token, {
          hospitalId: hospitalB,
          dataCategories: ['allergies'],
          validForDays: 30,
        })
      ).status,
    ).toBe(400);
  });

  it('in the database, lets a patient write only a portal consent over their own record', async () => {
    const { client: app, close } = appRoleDb();

    const attempt = (context: { hospital?: string; patient?: string }, sql: string, params: unknown[]) =>
      app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${context.hospital ?? ''}, true)`;
        await tx`SELECT set_config('app.current_patient_id', ${context.patient ?? ''}, true)`;
        await tx.unsafe(sql, params as never[]);
      });

    const insert = `
      INSERT INTO consent_artefact
        (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method,
         recorded_by_staff_id, recorded_by_patient_account_id)
      VALUES ($1, $2, '{allergies}', now() + interval '1 day', $3, $4, $5)
    `;

    try {
      // As staff would record it.
      await expect(
        attempt({ patient: lakshmiId }, insert, [lakshmiId, hospitalB, 'signed_form', frontDeskBId, null]),
      ).rejects.toThrow(/row-level security/);
      // For someone else's record.
      await expect(
        attempt({ patient: lakshmiId }, insert, [otherId, hospitalA, 'patient_portal', null, accountId]),
      ).rejects.toThrow(/row-level security/);
      // To a hospital where they are not registered.
      await expect(
        attempt({ patient: lakshmiId }, insert, [lakshmiId, hospitalC, 'patient_portal', null, accountId]),
      ).rejects.toThrow(/row-level security/);
      // A hospital claiming the patient granted it.
      await expect(
        attempt({ hospital: hospitalB }, insert, [lakshmiId, hospitalB, 'patient_portal', null, accountId]),
      ).rejects.toThrow(/row-level security/);
      // Lengthening a consent rather than revoking it.
      await expect(
        attempt(
          { patient: lakshmiId },
          `UPDATE consent_artefact SET expires_at = expires_at + interval '1 year' WHERE patient_id = $1`,
          [lakshmiId],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await close();
    }
  });
});
