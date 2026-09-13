import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  createTestApp,
  loadDemoTerminology,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * Medical records staff (Decision C).
 *
 * The hospital's day-to-day flow: a clerk transcribes the doctor's file. Every
 * entry they make belongs to the named clinician and says who typed it. The
 * clerk cannot enter anything in their own name, cannot name someone who is
 * not a clinician of their hospital, and cannot stop a medicine.
 */
describe('medical records staff', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let clinicianA: SeededStaff;
  let frontDeskA: SeededStaff;
  let recordsA: SeededStaff;
  let clinicianB: SeededStaff;

  let recordsToken: string;
  let clinicianToken: string;
  let adminToken: string;

  let patientId: string;
  let encounterId: string;

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  const transcribed = () => ({
    source: 'transcribed',
    enteredBy: { id: recordsA.id, name: expect.any(String) },
  });

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Records Test', mrnPrefix: 'SRT' });
    const b = await seedHospital({
      name: 'City General Records Test',
      mrnPrefix: 'GRT',
      facilityType: 'allopathic',
    });

    clinicianA = a.staff.clinician as SeededStaff;
    frontDeskA = a.staff.frontDesk as SeededStaff;
    recordsA = a.staff.records as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;

    recordsToken = await signIn(ctx, recordsA);
    clinicianToken = await signIn(ctx, clinicianA);
    adminToken = await signIn(ctx, a.staff.admin as SeededStaff);

    // Records staff register patients too: it is their desk the file arrives at.
    const registered = await post('/patients', recordsToken, {
      name: 'Kamala Records',
      gender: 'female',
      dateOfBirth: '1968-12-04',
      phone: '9820077771',
    });
    expect(registered.status).toBe(201);
    patientId = registered.body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('lists the hospital’s clinicians to transcribe for, and nobody else', async () => {
    const response = await get('/clinicians', recordsToken);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        id: clinicianA.id,
        name: expect.any(String),
        systemOfMedicine: 'ayurveda',
        status: 'active',
      },
    ]);
  });

  describe('encounters', () => {
    it('opens an encounter for a named clinician, under that clinician’s system', async () => {
      const response = await post('/encounters', recordsToken, {
        patientId,
        onBehalfOfClinicianId: clinicianA.id,
        chiefComplaint: 'From the OPD file: acidity for three months',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        attending: { id: clinicianA.id, name: expect.any(String) },
        systemOfMedicine: 'ayurveda',
        entry: transcribed(),
      });

      encounterId = response.body.id;
    });

    it('refuses to open one without naming the clinician', async () => {
      const response = await post('/encounters', recordsToken, { patientId });
      expect(response.status).toBe(400);
    });

    it('refuses to name someone who is not a clinician of this hospital', async () => {
      const notClinician = await post('/encounters', recordsToken, {
        patientId,
        onBehalfOfClinicianId: frontDeskA.id,
      });
      expect(notClinician.status).toBe(400);

      const otherHospital = await post('/encounters', recordsToken, {
        patientId,
        onBehalfOfClinicianId: clinicianB.id,
      });
      expect(otherHospital.status).toBe(400);
    });

    it('keeps clinicians entering in their own name', async () => {
      const own = await post('/encounters', clinicianToken, { patientId });

      expect(own.status).toBe(201);
      expect(own.body.entry).toEqual({
        source: 'direct',
        enteredBy: { id: clinicianA.id, name: expect.any(String) },
      });

      const forSomeoneElse = await post('/encounters', clinicianToken, {
        patientId,
        onBehalfOfClinicianId: clinicianB.id,
      });
      expect(forSomeoneElse.status).toBe(400);
    });
  });

  describe('clinical entries', () => {
    it('transcribes a diagnosis with its dual coding, in the clinician’s name', async () => {
      const response = await post('/diagnoses', recordsToken, {
        encounterId,
        code: 'DEMO-NAM-001',
        isPrimary: true,
        onBehalfOfClinicianId: clinicianA.id,
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        recordedBy: { id: clinicianA.id },
        entry: transcribed(),
        codings: {
          primary: { system: 'namaste', code: 'DEMO-NAM-001' },
          translated: { system: 'icd11-tm2' },
        },
      });
    });

    it('transcribes an allergy', async () => {
      const response = await post('/allergies', recordsToken, {
        patientId,
        substance: 'Sulfamethoxazole',
        category: 'medication',
        criticality: 'high',
        onBehalfOfClinicianId: clinicianA.id,
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        recordedBy: { id: clinicianA.id },
        entry: transcribed(),
      });
    });

    it('applies the allergy check to a transcribed prescription', async () => {
      const blocked = await post('/prescriptions', recordsToken, {
        encounterId,
        medicineName: 'sulfamethoxazole',
        frequency: 'twice daily',
        route: 'oral',
        onBehalfOfClinicianId: clinicianA.id,
      });

      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('ALLERGY_MATCH');

      const written = await post('/prescriptions', recordsToken, {
        encounterId,
        medicineName: 'Avipattikar churna',
        frequency: '1-0-1',
        route: 'oral',
        duration: { value: 4, unit: 'months' },
        onBehalfOfClinicianId: clinicianA.id,
      });

      expect(written.status).toBe(201);
      expect(written.body).toMatchObject({
        prescriber: { id: clinicianA.id, name: expect.any(String) },
        entry: transcribed(),
      });
    });

    it('reads the problem list and current medications', async () => {
      const problems = await get(`/patients/${patientId}/problems`, recordsToken);
      expect(problems.status).toBe(200);
      expect(problems.body.problems[0].entry.source).toBe('transcribed');

      const medications = await get(`/patients/${patientId}/medications`, recordsToken);
      expect(medications.status).toBe(200);
      expect(medications.body.medications).toHaveLength(1);
    });

    it('cannot stop a medicine: that is a clinician’s decision', async () => {
      const medications = await get(`/patients/${patientId}/medications`, recordsToken);
      const [medication] = medications.body.medications;

      const response = await post(`/prescriptions/${medication.id}/stop`, recordsToken, {
        reason: 'Transcribing a stop',
      });

      expect(response.status).toBe(403);
    });

    it('is audited as the records staff member who typed it', async () => {
      const rows = await owner<Array<{ resource: string }>>`
        SELECT resource_type AS resource
          FROM access_log
         WHERE actor_id = ${recordsA.id} AND action = 'create'
      ORDER BY at
      `;

      expect(rows.map((row) => row.resource)).toEqual(
        expect.arrayContaining([
          'encounter',
          'condition',
          'allergy_intolerance',
          'medication_request',
        ]),
      );
    });
  });

  describe('the boundaries that do not move', () => {
    it('keeps records staff out of staff administration', async () => {
      expect((await get('/staff', recordsToken)).status).toBe(403);
    });

    it('keeps the hospital admin out of clinical data', async () => {
      expect((await get(`/patients/${patientId}/problems`, adminToken)).status).toBe(403);
      expect(
        (
          await post('/encounters', adminToken, {
            patientId,
            onBehalfOfClinicianId: clinicianA.id,
          })
        ).status,
      ).toBe(403);
    });
  });
});
