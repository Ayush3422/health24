import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
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
 * The rest of the clinical record's endpoints (T26).
 *
 * Encounters, allergies, diagnoses and prescriptions are exercised across
 * hospitals in their own suites. This one does the same for vitals, notes,
 * procedures and an encounter's prescriptions — without consent, under it,
 * and after revocation, with the consent named in the audit trail — and
 * covers the correction routes no other suite calls.
 */
describe('clinical record coverage: documentation across hospitals', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let clinicianB: SeededStaff;
  let tokenA: string;
  let tokenB: string;
  let frontDeskBToken: string;

  let patientId: string;
  let encounterA: string;
  let noteId: string;
  let procedureId: string;
  let prescriptionId: string;
  let consentId: string;

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  const encounterLists = ['vitals', 'notes', 'procedures', 'prescriptions'] as const;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Coverage Test', mrnPrefix: 'SCV' });
    const b = await seedHospital({
      name: 'City General Coverage Test',
      mrnPrefix: 'GCV',
      facilityType: 'allopathic',
    });

    clinicianB = b.staff.clinician as SeededStaff;
    tokenA = await signIn(ctx, a.staff.clinician as SeededStaff);
    tokenB = await signIn(ctx, clinicianB);
    frontDeskBToken = await signIn(ctx, b.staff.frontDesk as SeededStaff);

    const registered = await post(
      '/patients',
      await signIn(ctx, a.staff.frontDesk as SeededStaff),
      {
        name: 'Kamala Coverage',
        gender: 'female',
        dateOfBirth: '1967-07-07',
        phone: '9820099991',
      },
    );
    patientId = registered.body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
        VALUES (${patientId}, ${b.hospital.id}, 'GCV-000001')
      `;
    });

    encounterA = (await post('/encounters', tokenA, { patientId })).body.id;

    const vitals = await post('/vitals', tokenA, {
      patientId,
      encounterId: encounterA,
      readings: { systolic: 130, diastolic: 85, heartRate: 80 },
    });
    expect(vitals.status).toBe(201);

    const note = await post('/notes', tokenA, {
      encounterId: encounterA,
      template: 'general',
      sections: { subjective: 'Burning after meals' },
    });
    expect(note.status).toBe(201);
    noteId = note.body.id;

    const procedure = await post('/procedures', tokenA, {
      encounterId: encounterA,
      name: 'Shirodhara',
      outcome: 'Tolerated well',
    });
    expect(procedure.status).toBe(201);
    procedureId = procedure.body.id;

    const prescription = await post('/prescriptions', tokenA, {
      encounterId: encounterA,
      medicineName: 'Avipattikar churna',
      frequency: '1-0-1',
      route: 'oral',
      duration: { value: 2, unit: 'months' },
    });
    expect(prescription.status).toBe(201);
    prescriptionId = (prescription.body.prescription ?? prescription.body).id;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  describe('another hospital, without consent', () => {
    it('cannot name the encounter, so none of its lists exist for it', async () => {
      for (const list of encounterLists) {
        const response = await get(`/encounters/${encounterA}/${list}`, tokenB);
        expect(response.status, list).toBe(404);
      }
    });

    it('sees none of the patient’s vitals or procedures, and is told so', async () => {
      const vitals = await get(`/patients/${patientId}/vitals`, tokenB);
      expect(vitals.body).toEqual({ sets: [], sharedFromOtherHospitals: false });

      const procedures = await get(`/patients/${patientId}/procedures`, tokenB);
      expect(procedures.status).toBe(200);
      expect(JSON.stringify(procedures.body)).not.toContain('Shirodhara');
    });
  });

  describe('another hospital, under consent', () => {
    it('sees each kind of record exactly when its category is shared', async () => {
      const consent = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['encounters', 'observations', 'notes'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(consent.status).toBe(201);
      consentId = consent.body.id;

      const vitals = await get(`/encounters/${encounterA}/vitals`, tokenB);
      expect(vitals.status).toBe(200);
      expect(vitals.body).toHaveLength(1);
      expect(vitals.body[0].hospital.isOwn).toBe(false);

      const notes = await get(`/encounters/${encounterA}/notes`, tokenB);
      expect(notes.body.map((entry: { id: string }) => entry.id)).toEqual([noteId]);

      // The encounter is shared; its procedures and prescriptions are not.
      expect((await get(`/encounters/${encounterA}/procedures`, tokenB)).body).toEqual([]);
      expect((await get(`/encounters/${encounterA}/prescriptions`, tokenB)).body).toEqual([]);

      const patientVitals = await get(`/patients/${patientId}/vitals`, tokenB);
      expect(patientVitals.body.sets).toHaveLength(1);
      expect(patientVitals.body.sharedFromOtherHospitals).toBe(true);
    });

    it('names the consent on every shared read in the audit trail, and no other', async () => {
      const rows = await owner<Array<{ resource_type: string; consent: string | null }>>`
        SELECT DISTINCT resource_type, consent_artefact_id::text AS consent
          FROM access_log
         WHERE actor_id = ${clinicianB.id} AND action = 'read'
           AND at > (SELECT granted_at FROM consent_artefact WHERE id = ${consentId})
      `;

      const byType = (type: string) =>
        rows.filter((row) => row.resource_type === type).map((row) => row.consent);

      expect(byType('observation')).toContain(consentId);
      expect(byType('clinical_note')).toEqual([consentId]);
      // Nothing of these was shared, so no consent is claimed for reading them.
      expect(byType('procedure')).toEqual([null]);
      expect(byType('medication_request')).toEqual([null]);
    });

    it('sees nothing again the moment consent is revoked', async () => {
      const revoked = await post(`/consents/${consentId}/revoke`, frontDeskBToken, {
        reason: 'Patient withdrew consent',
      });
      expect(revoked.status).toBe(200);

      expect((await get(`/encounters/${encounterA}/notes`, tokenB)).status).toBe(404);
      expect((await get(`/patients/${patientId}/vitals`, tokenB)).body.sets).toEqual([]);
    });
  });

  describe('corrections no other suite calls', () => {
    let correctedProcedureId: string;

    it('lists the encounter’s procedures, and corrects one as a new version', async () => {
      const listed = await get(`/encounters/${encounterA}/procedures`, tokenA);
      expect(listed.status).toBe(200);
      expect(listed.body.map((entry: { id: string }) => entry.id)).toEqual([procedureId]);

      const corrected = await post(`/procedures/${procedureId}/correct`, tokenA, {
        name: 'Shirodhara',
        outcome: 'Tolerated well; slept better that night',
        reason: 'Outcome recorded incompletely',
      });
      expect(corrected.status).toBe(201);
      correctedProcedureId = corrected.body.id;
      expect(correctedProcedureId).not.toBe(procedureId);

      const history = await get(`/clinical-history/procedures/${correctedProcedureId}`, tokenA);
      expect(history.body.map((entry: { versionStatus: string }) => entry.versionStatus)).toEqual(
        expect.arrayContaining(['current', 'superseded']),
      );
    });

    it('does not let another hospital mark an entry in error, even where consent shows it', async () => {
      const consent = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['encounters', 'notes', 'procedures', 'medications'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(consent.status).toBe(201);

      for (const path of [
        `/notes/${noteId}/entered-in-error`,
        `/procedures/${correctedProcedureId}/entered-in-error`,
        `/prescriptions/${prescriptionId}/entered-in-error`,
      ]) {
        const response = await post(path, tokenB, { reason: 'Not ours to change' });
        expect(response.status, path).toBe(403);
      }
    });

    it('marks a note, a procedure and a prescription entered in error, taking each off its list', async () => {
      const reason = { reason: 'Recorded against the wrong patient' };

      expect((await post(`/notes/${noteId}/entered-in-error`, tokenA, reason)).status).toBe(200);
      expect(
        (await post(`/procedures/${correctedProcedureId}/entered-in-error`, tokenA, reason)).status,
      ).toBe(200);
      expect(
        (await post(`/prescriptions/${prescriptionId}/entered-in-error`, tokenA, reason)).status,
      ).toBe(200);

      expect((await get(`/encounters/${encounterA}/notes`, tokenA)).body).toEqual([]);
      expect((await get(`/encounters/${encounterA}/procedures`, tokenA)).body).toEqual([]);
      expect((await get(`/encounters/${encounterA}/prescriptions`, tokenA)).body).toEqual([]);

      // Marking twice is refused: the entry is no longer current.
      const again = await post(`/notes/${noteId}/entered-in-error`, tokenA, reason);
      expect(again.status).toBe(409);
    });
  });
});
