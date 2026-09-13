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
 * Vitals, notes and procedures, and correcting any clinical entry.
 *
 * The record's promise is that nothing clinical is edited or deleted. These
 * tests hold the application to it: a correction is a new version, the
 * original stays in the entry's history with who changed it and why, and a
 * mistake is marked entered in error rather than removed.
 */
describe('documentation and corrections', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let clinicianA: SeededStaff;
  let recordsA: SeededStaff;
  let clinicianToken: string;
  let recordsToken: string;
  let otherHospitalToken: string;

  let patientId: string;
  let encounterId: string;

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Documentation Test', mrnPrefix: 'SDC' });
    const b = await seedHospital({
      name: 'City General Documentation Test',
      mrnPrefix: 'GDC',
      facilityType: 'allopathic',
    });

    clinicianA = a.staff.clinician as SeededStaff;
    recordsA = a.staff.records as SeededStaff;

    clinicianToken = await signIn(ctx, clinicianA);
    recordsToken = await signIn(ctx, recordsA);
    otherHospitalToken = await signIn(ctx, b.staff.clinician as SeededStaff);

    const registered = await post('/patients', clinicianToken, {
      name: 'Kamala Documentation',
      gender: 'female',
      dateOfBirth: '1972-06-18',
      phone: '9820088881',
    });
    patientId = registered.body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
        VALUES (${patientId}, ${b.hospital.id}, 'GDC-000001')
      `;
    });

    encounterId = (await post('/encounters', clinicianToken, { patientId })).body.id;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  describe('vitals', () => {
    let setId: string;

    it('records a set of vital signs with LOINC codes, deriving BMI', async () => {
      const response = await post('/vitals', clinicianToken, {
        patientId,
        encounterId,
        readings: {
          systolic: 128,
          diastolic: 84,
          heartRate: 76,
          temperature: 37.2,
          oxygenSaturation: 98,
          height: 160,
          weight: 64,
        },
      });

      expect(response.status).toBe(201);

      const values = Object.fromEntries(
        response.body.readings.map((reading: { key: string; value: number }) => [
          reading.key,
          reading.value,
        ]),
      );

      expect(values).toEqual({
        systolic: 128,
        diastolic: 84,
        heartRate: 76,
        temperature: 37.2,
        oxygenSaturation: 98,
        height: 160,
        weight: 64,
        bmi: 25,
      });

      expect(response.body.readings[0]).toMatchObject({
        key: 'systolic',
        code: '8480-6',
        unit: 'mm[Hg]',
      });
      expect(response.body).toMatchObject({
        encounterId,
        recordedBy: { id: clinicianA.id },
        entry: { source: 'direct' },
      });

      setId = response.body.id;
    });

    it('refuses half a blood pressure, an implausible reading, and an empty set', async () => {
      const half = await post('/vitals', clinicianToken, {
        patientId,
        readings: { systolic: 120 },
      });
      expect(half.status).toBe(400);

      const implausible = await post('/vitals', clinicianToken, {
        patientId,
        readings: { heartRate: 720 },
      });
      expect(implausible.status).toBe(400);

      const empty = await post('/vitals', clinicianToken, { patientId, readings: {} });
      expect(empty.status).toBe(400);
    });

    it('lists the sets for the patient and for the encounter', async () => {
      const forPatient = await get(`/patients/${patientId}/vitals`, clinicianToken);
      expect(forPatient.status).toBe(200);
      expect(forPatient.body.sets.map((set: { id: string }) => set.id)).toEqual([setId]);
      expect(forPatient.body.sharedFromOtherHospitals).toBe(false);

      const forEncounter = await get(`/encounters/${encounterId}/vitals`, clinicianToken);
      expect(forEncounter.body).toHaveLength(1);
    });

    it('marks a mistaken set entered in error as a whole, once', async () => {
      const marked = await post(`/vitals/${setId}/entered-in-error`, clinicianToken, {
        reason: 'Readings belonged to another patient',
      });

      expect(marked.status).toBe(200);
      expect(marked.body).toEqual({ id: setId, versionStatus: 'entered_in_error' });

      const after = await get(`/patients/${patientId}/vitals`, clinicianToken);
      expect(after.body.sets).toEqual([]);

      const again = await post(`/vitals/${setId}/entered-in-error`, clinicianToken, {
        reason: 'Readings belonged to another patient',
      });
      expect(again.status).toBe(409);

      const [remaining] = await owner<Array<{ count: string }>>`
        SELECT count(*) AS count FROM observation WHERE group_id = ${setId}
      `;
      expect(Number(remaining?.count), 'marked, never deleted').toBe(8);
    });
  });

  describe('notes', () => {
    let firstVersion: string;
    let secondVersion: string;

    it('writes an Ayurveda initial assessment in its template sections', async () => {
      const response = await post('/notes', clinicianToken, {
        encounterId,
        template: 'ayurveda_initial',
        title: 'First visit',
        sections: {
          ashtavidha_pariksha: 'Nadi: tikshna. Jihva: lipta.',
          pradhana_vedana: 'Burning in the chest after meals',
          plan: '',
        },
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        template: 'ayurveda_initial',
        templateLabel: 'Ayurveda initial assessment',
        title: 'First visit',
        supersedesId: null,
      });

      // In the template's order, with empty sections left out.
      expect(response.body.sections.map((section: { key: string }) => section.key)).toEqual([
        'pradhana_vedana',
        'ashtavidha_pariksha',
      ]);

      firstVersion = response.body.id;
    });

    it('refuses a section the template does not have, and an empty note', async () => {
      const wrongSection = await post('/notes', clinicianToken, {
        encounterId,
        template: 'follow_up',
        sections: { pradhana_vedana: 'Not a follow-up section' },
      });
      expect(wrongSection.status).toBe(400);

      const empty = await post('/notes', clinicianToken, {
        encounterId,
        template: 'general',
        sections: { subjective: '   ' },
      });
      expect(empty.status).toBe(400);
    });

    it('amends a note as a new version, keeping the original in its history', async () => {
      const amended = await post(`/notes/${firstVersion}/correct`, clinicianToken, {
        template: 'ayurveda_initial',
        title: 'First visit',
        sections: {
          pradhana_vedana: 'Burning in the chest after meals',
          ashtavidha_pariksha: 'Nadi: tikshna. Jihva: lipta.',
          plan: 'Avipattikar churna; avoid fermented food',
        },
        reason: 'Added the plan',
      });

      expect(amended.status).toBe(201);
      expect(amended.body.supersedesId).toBe(firstVersion);
      secondVersion = amended.body.id;

      const onEncounter = await get(`/encounters/${encounterId}/notes`, clinicianToken);
      expect(onEncounter.body.map((note: { id: string }) => note.id)).toEqual([secondVersion]);

      for (const id of [firstVersion, secondVersion]) {
        const history = await get(`/clinical-history/notes/${id}`, clinicianToken);

        expect(history.status).toBe(200);
        expect(
          history.body.map((entry: { id: string; version: number; versionStatus: string }) => [
            entry.id,
            entry.version,
            entry.versionStatus,
          ]),
        ).toEqual([
          [firstVersion, 1, 'superseded'],
          [secondVersion, 2, 'current'],
        ]);
        expect(history.body[0]).toMatchObject({
          statusReason: 'Added the plan',
          statusChangedBy: { id: clinicianA.id },
        });
      }
    });

    it('refuses to correct a version that has already been corrected', async () => {
      const response = await post(`/notes/${firstVersion}/correct`, clinicianToken, {
        template: 'general',
        sections: { plan: 'Late change' },
        reason: 'Trying the old version',
      });

      expect(response.status).toBe(409);
    });
  });

  describe('procedures', () => {
    it('records a Panchakarma therapy, performed by the attending clinician by default', async () => {
      const response = await post('/procedures', clinicianToken, {
        encounterId,
        name: 'Shirodhara',
        outcome: 'Tolerated well',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        name: 'Shirodhara',
        systemOfMedicine: 'ayurveda',
        outcome: 'Tolerated well',
        performer: { id: clinicianA.id },
        recordedBy: { id: clinicianA.id },
      });
    });

    it('refuses a performer who is not a clinician, and a time in the future', async () => {
      const notClinician = await post('/procedures', clinicianToken, {
        encounterId,
        name: 'Pizhichil',
        performerClinicianId: recordsA.id,
      });
      expect(notClinician.status).toBe(400);

      const future = await post('/procedures', clinicianToken, {
        encounterId,
        name: 'Pizhichil',
        performedAt: '2999-01-01T10:00:00+05:30',
      });
      expect(future.status).toBe(400);
    });

    it('lists the patient’s procedures', async () => {
      const response = await get(`/patients/${patientId}/procedures`, clinicianToken);

      expect(response.status).toBe(200);
      expect(response.body.procedures.map((row: { name: string }) => row.name)).toEqual([
        'Shirodhara',
      ]);
    });
  });

  describe('corrections', () => {
    let originalDiagnosis: string;
    let correctedDiagnosis: string;
    let clinicianAllergy: string;

    it('corrects a diagnosis to a different term, re-coding it and keeping it primary', async () => {
      const recorded = await post('/diagnoses', clinicianToken, {
        encounterId,
        code: 'DEMO-NAM-001',
        isPrimary: true,
      });
      originalDiagnosis = recorded.body.id;

      const corrected = await post(`/diagnoses/${originalDiagnosis}/correct`, clinicianToken, {
        code: 'DEMO-NAM-002',
        isPrimary: true,
        reason: 'Revised after examination',
      });

      expect(corrected.status).toBe(201);
      expect(corrected.body).toMatchObject({
        supersedesId: originalDiagnosis,
        isPrimary: true,
        codings: {
          primary: { code: 'DEMO-NAM-002' },
          translated: { code: 'DEMO-TM2-02' },
        },
      });
      correctedDiagnosis = corrected.body.id;

      const problems = await get(`/patients/${patientId}/problems`, clinicianToken);
      const ids = problems.body.problems.map((row: { id: string }) => row.id);
      expect(ids).toContain(correctedDiagnosis);
      expect(ids).not.toContain(originalDiagnosis);
    });

    it('shows both terms in the diagnosis history', async () => {
      const history = await get(
        `/clinical-history/diagnoses/${correctedDiagnosis}`,
        clinicianToken,
      );

      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(2);
      expect(history.body[0].label).toContain('Amlapitta');
      expect(history.body[1].label).toContain('DEMO-NAM-002');
    });

    it('checks allergies again when a prescription is corrected', async () => {
      const allergy = await post('/allergies', clinicianToken, {
        patientId,
        substance: 'Triphala churna',
        category: 'medication',
        criticality: 'high',
      });
      clinicianAllergy = allergy.body.id;

      const prescribed = await post('/prescriptions', clinicianToken, {
        encounterId,
        medicineName: 'Avipattikar churna',
        frequency: '1-0-1',
        route: 'oral',
      });
      expect(prescribed.status).toBe(201);

      const toAllergen = await post(
        `/prescriptions/${prescribed.body.id}/correct`,
        clinicianToken,
        {
          medicineName: 'triphala churna',
          frequency: '1-0-1',
          route: 'oral',
          reason: 'Wrong formulation written',
        },
      );
      expect(toAllergen.status).toBe(409);
      expect(toAllergen.body.code).toBe('ALLERGY_MATCH');

      const doseFixed = await post(`/prescriptions/${prescribed.body.id}/correct`, clinicianToken, {
        medicineName: 'Avipattikar churna',
        dose: { quantity: 5, unit: 'g' },
        frequency: '1-0-1',
        route: 'oral',
        reason: 'Dose left out',
      });
      expect(doseFixed.status).toBe(201);
      expect(doseFixed.body).toMatchObject({
        supersedesId: prescribed.body.id,
        dose: { quantity: 5, unit: 'g' },
      });

      const current = await get(`/patients/${patientId}/medications`, clinicianToken);
      const ids = current.body.medications.map((row: { id: string }) => row.id);
      expect(ids).toEqual([doseFixed.body.id]);
    });

    it('resolves an allergy through a correction, taking it off the banner', async () => {
      const resolved = await post(`/allergies/${clinicianAllergy}/correct`, clinicianToken, {
        substance: 'Triphala churna',
        category: 'medication',
        criticality: 'high',
        clinicalStatus: 'resolved',
        reason: 'Tolerated on rechallenge',
      });

      expect(resolved.status).toBe(201);
      expect(resolved.body).toMatchObject({
        clinicalStatus: 'resolved',
        supersedesId: clinicianAllergy,
      });
      clinicianAllergy = resolved.body.id;

      const banner = await get(`/patients/${patientId}/allergies`, clinicianToken);
      expect(banner.body.allergies).toEqual([]);
    });

    it('marks a diagnosis entered in error, keeping the reason in its history', async () => {
      const marked = await post(
        `/diagnoses/${correctedDiagnosis}/entered-in-error`,
        clinicianToken,
        {
          reason: 'Recorded on the wrong patient',
        },
      );

      expect(marked.status).toBe(200);
      expect(marked.body.versionStatus).toBe('entered_in_error');

      const problems = await get(`/patients/${patientId}/problems`, clinicianToken);
      expect(problems.body.problems).toEqual([]);

      const history = await get(`/clinical-history/diagnoses/${originalDiagnosis}`, clinicianToken);
      expect(history.body.at(-1)).toMatchObject({
        versionStatus: 'entered_in_error',
        statusReason: 'Recorded on the wrong patient',
      });
    });

    it('does not let another hospital change an entry it cannot see', async () => {
      const response = await post(
        `/allergies/${clinicianAllergy}/entered-in-error`,
        otherHospitalToken,
        {
          reason: 'Not ours',
        },
      );

      expect(response.status).toBe(404);
    });

    it('lets records staff correct what they typed, in the same clinician’s name', async () => {
      const typed = await post('/allergies', recordsToken, {
        patientId,
        substance: 'Dust',
        category: 'environment',
        onBehalfOfClinicianId: clinicianA.id,
      });

      const corrected = await post(`/allergies/${typed.body.id}/correct`, recordsToken, {
        substance: 'House dust',
        category: 'environment',
        criticality: 'low',
        reason: 'Typing error',
      });

      expect(corrected.status).toBe(201);
      expect(corrected.body).toMatchObject({
        substance: 'House dust',
        recordedBy: { id: clinicianA.id },
        entry: { source: 'transcribed', enteredBy: { id: recordsA.id } },
      });
    });

    it('does not let records staff change a clinician’s own entry', async () => {
      const response = await post(`/allergies/${clinicianAllergy}/entered-in-error`, recordsToken, {
        reason: 'Trying to remove it',
      });

      expect(response.status).toBe(403);
    });
  });
});
