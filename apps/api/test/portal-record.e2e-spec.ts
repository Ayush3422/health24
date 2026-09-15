import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
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
  let hospitalAId: string;
  let clinicianBId: string;
  let documentId: string;
  const fileId = randomUUID();
  /** Staff names by id, as the database holds them. */
  const names: Record<string, string> = {};

  const LAKSHMI = { name: 'Lakshmi Summary', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820077001' };

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
    hospitalAId = a.hospital.id;
    clinicianBId = clinicianB.id;

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

      const [report] = await tx<Array<{ id: string }>>`
        INSERT INTO document_reference (patient_id, hospital_id, doc_type, title, report_date, availability, availability_changed_at, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${b.hospital.id}, 'lab_report', 'Liver function test', CURRENT_DATE - 3, 'available', now(), ${clinicianB.id})
        RETURNING id
      `;
      documentId = report!.id;

      await tx`
        INSERT INTO document_file (id, document_id, patient_id, hospital_id, position, storage_key, mime_type, size_bytes, scan_status, scanned_at)
        VALUES (${fileId}, ${documentId}, ${lakshmiId}, ${b.hospital.id}, 1,
                ${`hospitals/${b.hospital.id}/patients/${lakshmiId}/documents/${documentId}/${fileId}`},
                'application/pdf', 1200, 'clean', now())
      `;

      for (const row of await tx<Array<{ id: string; name: string }>>`
        SELECT id::text, name FROM staff_user WHERE id IN (${clinicianA.id}, ${clinicianB.id})
      `) {
        names[row.id] = row.name;
      }
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

    expect((await get('/portal/timeline', token)).body.items).toEqual([]);
    expect((await get('/portal/documents', token)).body).toMatchObject({ results: [], total: 0 });
    expect((await get('/portal/results', token)).body.sets).toEqual([]);
    expect(
      (await get(`/portal/documents/${documentId}/files/${fileId}/url`, token)).status,
    ).toBe(404);
    expect((await get('/portal/results/trends?code=1742-6', token)).body.points).toEqual([]);
  });

  it('shows the patient their timeline at every hospital, with who treated them', async () => {
    const token = await portalToken(LAKSHMI.phone, lakshmiId);
    const response = await get('/portal/timeline', token);

    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const items = response.body.items as Array<{
      kind: string;
      title: string;
      hospital: { name: string; isOwn: boolean };
      clinician: { id: string; name: string | null };
    }>;

    expect(items.map((item) => item.kind).sort()).toEqual(
      ['allergy', 'document', 'encounter', 'encounter', 'prescription', 'result'].sort(),
    );
    expect(new Set(items.map((item) => item.hospital.name))).toEqual(
      new Set(['Sanjeevani Summary Test', 'City General Summary Test']),
    );

    for (const item of items) {
      expect(item.hospital.isOwn).toBe(false);
      expect(names[item.clinician.id], item.kind).toBeDefined();
      expect(item.clinician.name, item.kind).toBe(names[item.clinician.id]);
    }

    expect(response.body.sharedCategories).toEqual([]);

    const medicines = await get('/portal/timeline?categories=medications', token);
    expect(medicines.body.items.map((item: { title: string }) => item.title)).toEqual([
      'Avipattikar churna 5 g',
    ]);

    const [audited] = await owner<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM access_log
       WHERE resource_type = 'timeline' AND actor_type = 'patient' AND patient_id = ${lakshmiId}
    `;
    expect(audited!.count).toBe(2);
  });

  it('lists the patient’s reports and gives a download link, audited as an export', async () => {
    const token = await portalToken(LAKSHMI.phone, lakshmiId);
    const list = await get('/portal/documents', token);

    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toMatchObject({ total: 1, sharedFromOtherHospitals: false });
    expect(list.body.results[0]).toMatchObject({
      id: documentId,
      title: 'Liver function test',
      hospital: { name: 'City General Summary Test', isOwn: false },
      recordedBy: { id: clinicianBId, name: names[clinicianBId] },
    });

    const link = await get(
      `/portal/documents/${documentId}/files/${fileId}/url?disposition=attachment`,
      token,
    );
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.disposition).toBe('attachment');
    expect(link.body.url).toContain(documentId);

    const [audited] = await owner<Array<{ action: string; actor_type: string }>>`
      SELECT action::text, actor_type::text FROM access_log
       WHERE resource_type = 'document_file' AND resource_id = ${fileId}
    `;
    expect(audited).toEqual({ action: 'export', actor_type: 'patient' });
  });

  it('shows the patient their results and a trend in one unit', async () => {
    const token = await portalToken(LAKSHMI.phone, lakshmiId);

    const results = await get('/portal/results', token);
    expect(results.status, JSON.stringify(results.body)).toBe(200);
    expect(results.body.sets).toHaveLength(1);
    expect(results.body.sets[0].results[0]).toMatchObject({
      label: 'ALT (SGPT)',
      value: 72,
      interpretation: 'high',
    });

    const trend = await get('/portal/results/trends?code=1742-6', token);
    expect(trend.status, JSON.stringify(trend.body)).toBe(200);
    expect(trend.body.points).toEqual([
      expect.objectContaining({
        value: 72,
        hospital: expect.objectContaining({ name: 'City General Summary Test', isOwn: false }),
      }),
    ]);

    expect((await get('/portal/results/trends?code=not-an-analyte', token)).status).toBe(400);
  });

  it('names staff to a patient only in the patient context, and only where they are registered', async () => {
    const { client: app, close } = appRoleDb();

    const nameIn = async (context: { hospital?: string; patient?: string }, staffId: string) =>
      (await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${context.hospital ?? ''}, true)`;
        await tx`SELECT set_config('app.current_patient_id', ${context.patient ?? ''}, true)`;
        const [row] = await tx<Array<{ name: string | null }>>`
          SELECT app.staff_name_for_patient(${staffId}::uuid) AS name
        `;
        return row!.name;
      })) as unknown as string | null;

    try {
      expect(await nameIn({ patient: lakshmiId }, clinicianBId)).toBe(names[clinicianBId]);
      // Registered at the first hospital only.
      expect(await nameIn({ patient: otherId }, clinicianBId)).toBeNull();
      // Staff reach names through their own hospital's rows, never this way.
      expect(await nameIn({ hospital: hospitalAId, patient: lakshmiId }, clinicianBId)).toBeNull();
      expect(await nameIn({}, clinicianBId)).toBeNull();
    } finally {
      await close();
    }
  });
});
