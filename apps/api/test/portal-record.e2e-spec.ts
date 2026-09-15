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
 * The patient's own summary in the portal (SP5 Phase 2): their record at every
 * hospital, with no consent recorded anywhere, and nobody else's.
 */
describe('patient portal summary', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;

  let lakshmiId: string;
  let otherId: string;

  const LAKSHMI = { name: 'Lakshmi Summary', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820077001' };

  const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (token ? request.set('Authorization', `Bearer ${token}`) : request).send(body);
  };

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

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    const a = await seedHospital({ name: 'Sanjeevani Summary Test', mrnPrefix: 'SST' });
    const b = await seedHospital({ name: 'City General Summary Test', mrnPrefix: 'GST', facilityType: 'allopathic' });

    const deskA = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    const deskB = await signIn(ctx, b.staff.frontDesk as SeededStaff);
    const clinicianA = a.staff.clinician as SeededStaff;
    const clinicianB = b.staff.clinician as SeededStaff;

    lakshmiId = (await post('/patients', deskA, LAKSHMI)).body.patient.id;
    expect((await post('/patients', deskB, LAKSHMI)).body.linkedExisting).toBe(true);
    otherId = (
      await post('/patients', deskA, { name: 'Other Summary', gender: 'male', dateOfBirth: '1990-01-01', phone: '9820077002' })
    ).body.patient.id;

    for (const [patientId, phone] of [
      [lakshmiId, LAKSHMI.phone],
      [otherId, '9820077002'],
    ] as const) {
      expect(
        (await post(`/patients/${patientId}/portal-access`, deskA, { phone, identityConfirmed: true })).status,
      ).toBe(201);
    }

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    // Records at both hospitals, and no consent anywhere.
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [atA] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id, status, started_at, ended_at)
        VALUES (${lakshmiId}, ${a.hospital.id}, 'outpatient', 'ayurveda', ${clinicianA.id}, ${clinicianA.id}, 'finished', now() - interval '40 days', now() - interval '40 days' + interval '20 minutes')
        RETURNING id
      `;
      await tx`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id, status, started_at, ended_at)
        VALUES (${lakshmiId}, ${b.hospital.id}, 'outpatient', 'allopathy', ${clinicianB.id}, ${clinicianB.id}, 'finished', now() - interval '2 days', now() - interval '2 days' + interval '20 minutes')
      `;

      await tx`
        INSERT INTO allergy_intolerance (patient_id, hospital_id, encounter_id, substance, category, criticality, reaction, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${a.hospital.id}, ${atA!.id}, 'Penicillin', 'medication', 'high', 'Hives', ${clinicianA.id}, ${clinicianA.id})
      `;

      await tx`
        INSERT INTO medication_request (patient_id, hospital_id, encounter_id, system_of_medicine, medicine_name, strength, frequency, route, duration_value, duration_unit, start_date, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${a.hospital.id}, ${atA!.id}, 'ayurveda', 'Avipattikar churna', '5 g', '1-0-1', 'oral', 2, 'months', CURRENT_DATE - 40, ${clinicianA.id}, ${clinicianA.id})
      `;

      await tx`
        INSERT INTO observation (patient_id, hospital_id, category, source, code_system, code, display, value_quantity, unit, value_canonical, unit_canonical, reference_low, reference_high, interpretation, panel_code, group_id, effective_at, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${b.hospital.id}, 'laboratory', 'entered', 'http://loinc.org', '1742-6', 'Alanine aminotransferase', 72, 'U/L', 72, 'U/L', 7, 56, 'high', 'lft', gen_random_uuid(), now() - interval '3 days', ${clinicianB.id})
      `;
    });
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('shows the patient their own record at every hospital, with no consent recorded', async () => {
    const token = await portalToken(LAKSHMI.phone, lakshmiId);
    const response = await ctx.http().get('/api/v1/portal/summary').set('Authorization', `Bearer ${token}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.patient.name).toBe('Lakshmi Summary');
    expect(response.body.patient.ageYears).toBeGreaterThanOrEqual(58);

    expect(response.body.allergies).toEqual([
      expect.objectContaining({ substance: 'Penicillin', highRisk: true, hospitalName: 'Sanjeevani Summary Test' }),
    ]);
    expect(response.body.medicines).toEqual([
      expect.objectContaining({
        name: 'Avipattikar churna 5 g',
        howToTake: expect.stringContaining('1-0-1'),
        hospitalName: 'Sanjeevani Summary Test',
      }),
    ]);
    expect(response.body.abnormalResults).toEqual([
      expect.objectContaining({ label: 'ALT (SGPT)', value: 72, direction: 'higher', hospitalName: 'City General Summary Test' }),
    ]);
    expect(response.body.lastVisit).toMatchObject({ kind: 'outpatient', hospitalName: 'City General Summary Test' });
    expect(response.body.hospitals.map((hospital: { name: string }) => hospital.name)).toEqual([
      'Sanjeevani Summary Test',
      'City General Summary Test',
    ]);

    const [audited] = await owner<Array<{ actor_type: string; patient_id: string }>>`
      SELECT actor_type, patient_id::text FROM access_log WHERE resource_type = 'portal_summary'
    `;
    expect(audited).toEqual({ actor_type: 'patient', patient_id: lakshmiId });
  });

  it('shows another patient none of it', async () => {
    const token = await portalToken('9820077002', otherId);
    const response = await ctx.http().get('/api/v1/portal/summary').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      allergies: [],
      problems: [],
      medicines: [],
      abnormalResults: [],
      lastVisit: null,
    });
  });
});
