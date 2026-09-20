import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { ExportBuilder } from '../src/modules/exports/export-builder';
import { LogSmsSender } from '../src/modules/portal/sms';
import { StorageService } from '../src/modules/storage/storage.service';
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
 * The patient's copy of their own record (SP5 Phase 8, Decision N1): asked for
 * in the portal, built by the worker as a readable PDF and a FHIR R4 bundle,
 * downloaded through short-lived links, and removed when it expires.
 */
describe('a copy of my record', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;
  let storage: StorageService;

  let lakshmiId: string;
  let otherId: string;
  let exportId: string;

  const LAKSHMI = { name: 'Lakshmi Export', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820033101' };
  const OTHER = { name: 'Other Export', gender: 'male', dateOfBirth: '1990-01-01', phone: '9820033102' };

  const post = (path: string, bearer: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (bearer ? request.set('Authorization', `Bearer ${bearer}`) : request).send(body);
  };

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  async function portalToken(patient: { phone: string }, patientId: string): Promise<string> {
    await owner`DELETE FROM otp_challenge`;
    await post('/portal/auth/otp', null, { phone: patient.phone });
    const code = sms.lastTo(`+91${patient.phone}`)?.body.slice(0, 6);
    const verified = await post('/portal/auth/verify', null, { phone: patient.phone, code });
    const session = await post('/portal/auth/session', null, {
      selectionToken: verified.body.selectionToken,
      patientId,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    return session.body.accessToken as string;
  }

  async function keysOf(id: string): Promise<{ pdf_key: string; fhir_key: string }> {
    const [row] = await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return tx<Array<{ pdf_key: string; fhir_key: string }>>`
        SELECT pdf_key, fhir_key FROM data_export WHERE id = ${id}
      `;
    });
    return row!;
  }

  async function bytesOf(key: string): Promise<Buffer> {
    const stream = await storage.read(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  beforeAll(async () => {
    // A queue of its own, so no other worker takes these jobs.
    process.env.EXPORT_QUEUE_NAME = `patient-exports-test-${randomUUID()}`;

    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);
    storage = ctx.app.get(StorageService);
    await storage.ensureBucket();

    const a = await seedHospital({ name: 'Sanjeevani Export Test', mrnPrefix: 'SXT' });
    const desk = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    const clinician = a.staff.clinician as SeededStaff;

    lakshmiId = (await post('/patients', desk, LAKSHMI)).body.patient.id;
    otherId = (await post('/patients', desk, OTHER)).body.patient.id;

    for (const [patientId, phone] of [
      [lakshmiId, LAKSHMI.phone],
      [otherId, OTHER.phone],
    ] as const) {
      expect(
        (await post(`/patients/${patientId}/portal-access`, desk, { phone, identityConfirmed: true })).status,
      ).toBe(201);
    }

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [visit] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id, status, started_at, ended_at, chief_complaint)
        VALUES (${lakshmiId}, ${a.hospital.id}, 'outpatient', 'ayurveda', ${clinician.id}, ${clinician.id}, 'finished',
                now() - interval '30 days', now() - interval '30 days' + interval '20 minutes', 'Burning after meals')
        RETURNING id
      `;
      await tx`
        INSERT INTO allergy_intolerance (patient_id, hospital_id, encounter_id, substance, category, criticality, reaction, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${a.hospital.id}, ${visit!.id}, 'Penicillin', 'medication', 'high', 'Hives', ${clinician.id}, ${clinician.id})
      `;
      await tx`
        INSERT INTO medication_request (patient_id, hospital_id, encounter_id, system_of_medicine, medicine_name, strength, frequency, route, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${a.hospital.id}, ${visit!.id}, 'ayurveda', 'Avipattikar churna', '5 g', '1-0-1', 'oral', ${clinician.id}, ${clinician.id})
      `;
      await tx`
        INSERT INTO observation (patient_id, hospital_id, encounter_id, category, source, code_system, code, display, value_quantity, unit, value_canonical, unit_canonical, reference_low, reference_high, interpretation, panel_code, group_id, effective_at, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${a.hospital.id}, ${visit!.id}, 'laboratory', 'entered', 'http://loinc.org', '1742-6', 'Alanine aminotransferase', 72, 'U/L', 72, 'U/L', 7, 56, 'high', 'lft', gen_random_uuid(), now() - interval '20 days', ${clinician.id})
      `;
      await tx`
        INSERT INTO document_reference (patient_id, hospital_id, doc_type, title, report_date, availability, availability_changed_at, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${a.hospital.id}, 'lab_report', 'Liver function test', CURRENT_DATE - 20, 'available', now(), ${clinician.id})
      `;
    });
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('prepares the whole record as a PDF and a FHIR bundle, once at a time', async () => {
    const bearer = await portalToken(LAKSHMI, lakshmiId);

    const asked = await post('/portal/exports', bearer);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ status: 'pending', readyAt: null, entryCount: null });
    exportId = asked.body.id;

    // One at a time: a second request while one is being prepared is refused.
    expect((await post('/portal/exports', bearer)).status).toBe(409);
    expect((await get(`/portal/exports/${exportId}/download?format=pdf`, bearer)).status).toBe(409);

    expect(await ctx.app.get(ExportBuilder).build(exportId)).toBe('built');
    expect(await ctx.app.get(ExportBuilder).build(exportId)).toBe('skipped');

    const listed = await get('/portal/exports', bearer);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: exportId, status: 'ready', expiresAt: expect.any(String) }),
    ]);
    // A visit, an allergy, a medicine, a result and a report.
    expect(listed.body[0].entryCount).toBe(5);
  });

  it('holds the record itself: a readable PDF, and a FHIR bundle another system can read', async () => {
    const keys = await keysOf(exportId);

    const pdf = await bytesOf(keys.pdf_key);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.byteLength).toBeGreaterThan(1_000);

    const bundle = JSON.parse((await bytesOf(keys.fhir_key)).toString('utf8')) as {
      resourceType: string;
      type: string;
      entry: Array<{ resource: { resourceType: string; id: string } }>;
    };

    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'collection' });
    const kinds = bundle.entry.map((entry) => entry.resource.resourceType);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'Patient',
        'Encounter',
        'AllergyIntolerance',
        'MedicationRequest',
        'Observation',
        'DocumentReference',
      ]),
    );
    expect(bundle.entry.find((entry) => entry.resource.resourceType === 'Patient')?.resource.id).toBe(
      lakshmiId,
    );
  });

  it('hands the patient a link that lasts, and records the download', async () => {
    const bearer = await portalToken(LAKSHMI, lakshmiId);

    const pdf = await get(`/portal/exports/${exportId}/download?format=pdf`, bearer);
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(200);
    expect(pdf.body.url).toContain('record.pdf');

    const fhir = await get(`/portal/exports/${exportId}/download?format=fhir`, bearer);
    expect(fhir.body.url).toContain('record.fhir.json');
    expect((await get(`/portal/exports/${exportId}/download?format=zip`, bearer)).status).toBe(400);

    const [audited] = await owner<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM access_log
       WHERE resource_type = 'data_export' AND action = 'export' AND actor_type = 'patient'
    `;
    expect(audited!.count).toBe(2);
  });

  it('keeps one patient’s copy from another', async () => {
    const bearer = await portalToken(OTHER, otherId);

    expect((await get('/portal/exports', bearer)).body).toEqual([]);
    expect((await get(`/portal/exports/${exportId}/download?format=pdf`, bearer)).status).toBe(404);
  });

  it('removes the files when the copy expires', async () => {
    const keys = await keysOf(exportId);

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      await tx`UPDATE data_export SET expires_at = now() - interval '1 hour' WHERE id = ${exportId}`;
    });

    expect(await ctx.app.get(ExportBuilder).expireOld()).toBe(1);
    expect(await storage.describe(keys.pdf_key)).toBeNull();
    expect(await storage.describe(keys.fhir_key)).toBeNull();

    const bearer = await portalToken(LAKSHMI, lakshmiId);
    expect((await get('/portal/exports', bearer)).body[0].status).toBe('expired');
    expect((await get(`/portal/exports/${exportId}/download?format=pdf`, bearer)).status).toBe(409);
  });
});
