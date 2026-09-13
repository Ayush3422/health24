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
 * Encounters and allergies through the API.
 *
 * The database suite proves what row-level security permits. This one proves
 * the application on top of it: that a clinician can open and close a
 * consultation, that an allergy recorded at an Ayurvedic hospital reaches an
 * allopathic one only under consent, and that every such read names the
 * consent it rested on in the audit trail.
 */
describe('clinical API: encounters and allergies', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalA: { id: string; name: string };
  let hospitalB: { id: string; name: string };
  let clinicianAToken: string;
  let clinicianBToken: string;
  let clinicianA: SeededStaff;
  let clinicianB: SeededStaff;
  let frontDeskB: SeededStaff;

  /** Registered at A, then linked at B. */
  let patientId: string;
  /** Registered at A only. */
  let patientOnlyAtA: string;
  let encounterA: string;

  const get = (path: string, token: string) =>
    ctx.http().get(path).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(path).set('Authorization', `Bearer ${token}`).send(body);

  /** Arranges what the application has no route for yet, such as consent (Phase 6). */
  async function asSystem<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  async function grantConsent(categories: string): Promise<string> {
    const [row] = await asSystem(
      (tx) => tx<Array<{ id: string }>>`
      INSERT INTO consent_artefact
        (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method, recorded_by_staff_id)
      VALUES (${patientId}, ${hospitalB.id}, ${categories}::clinical_data_category[],
              now() + interval '90 days', 'signed_form', ${frontDeskB.id})
      RETURNING id
    `,
    );

    return row!.id;
  }

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Clinical Test', mrnPrefix: 'SCT' });
    const b = await seedHospital({
      name: 'City General Clinical Test',
      mrnPrefix: 'GCT',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital;
    hospitalB = b.hospital;
    clinicianA = a.staff.clinician as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;

    clinicianAToken = await signIn(ctx, clinicianA);
    clinicianBToken = await signIn(ctx, clinicianB);
    const frontDeskAToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);

    const registered = await post('/api/v1/patients', frontDeskAToken, {
      name: 'Kamala Clinical',
      gender: 'female',
      dateOfBirth: '1971-03-14',
      phone: '9820044441',
    });
    patientId = registered.body.patient.id;

    const other = await post('/api/v1/patients', frontDeskAToken, {
      name: 'Rajesh Elsewhere',
      gender: 'male',
      dateOfBirth: '1958-11-02',
      phone: '9820044442',
    });
    patientOnlyAtA = other.body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await asSystem(
      (tx) => tx`
      INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
      VALUES (${patientId}, ${hospitalB.id}, 'GCT-000001')
    `,
    );
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  describe('encounters', () => {
    it('opens an encounter under the clinician’s own system of medicine', async () => {
      const response = await post('/api/v1/encounters', clinicianAToken, {
        patientId,
        chiefComplaint: 'Burning after meals',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        patientId,
        class: 'outpatient',
        systemOfMedicine: 'ayurveda',
        status: 'in_progress',
        endedAt: null,
        chiefComplaint: 'Burning after meals',
        hospital: { id: hospitalA.id, name: hospitalA.name, isOwn: true },
        attending: { id: clinicianA.id, name: expect.any(String) },
        patient: { name: 'Kamala Clinical', mrn: expect.stringMatching(/^SCT-/) },
      });

      encounterA = response.body.id;
    });

    it('lets the clinician choose a different system of medicine', async () => {
      const response = await post('/api/v1/encounters', clinicianAToken, {
        patientId,
        class: 'teleconsultation',
        systemOfMedicine: 'yoga_naturopathy',
      });

      expect(response.status).toBe(201);
      expect(response.body.systemOfMedicine).toBe('yoga_naturopathy');

      const cancelled = await post(
        `/api/v1/encounters/${response.body.id}/cancel`,
        clinicianAToken,
        { reason: 'Opened for the wrong patient' },
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        status: 'cancelled',
        statusReason: 'Opened for the wrong patient',
      });
      expect(cancelled.body.endedAt).not.toBeNull();
    });

    it('refuses a patient the hospital is not linked to, as not found', async () => {
      const response = await post('/api/v1/encounters', clinicianBToken, {
        patientId: patientOnlyAtA,
      });

      expect(response.status).toBe(404);
    });

    it('lists today’s worklist for the hospital, and nothing on another day', async () => {
      const today = await get('/api/v1/encounters', clinicianAToken);

      expect(today.status).toBe(200);
      expect(today.body.results.map((row: { id: string }) => row.id)).toContain(encounterA);

      const inProgress = await get('/api/v1/encounters?status=in_progress', clinicianAToken);
      expect(inProgress.body.results.map((row: { id: string }) => row.id)).toEqual([encounterA]);

      const longAgo = await get('/api/v1/encounters?date=2001-01-01', clinicianAToken);
      expect(longAgo.body).toEqual({ results: [], total: 0 });
    });

    it('does not put another hospital’s encounters on the worklist', async () => {
      const response = await get('/api/v1/encounters', clinicianBToken);
      expect(response.body.results).toEqual([]);
    });

    it('shows another hospital nothing of the patient’s encounters without consent', async () => {
      const history = await get(`/api/v1/encounters?patientId=${patientId}`, clinicianBToken);
      expect(history.status).toBe(200);
      expect(history.body.results).toEqual([]);

      const direct = await get(`/api/v1/encounters/${encounterA}`, clinicianBToken);
      expect(direct.status).toBe(404);
    });

    it('shows another hospital the encounters under consent, and audits the consent', async () => {
      const consentId = await grantConsent('{encounters}');

      const history = await get(`/api/v1/encounters?patientId=${patientId}`, clinicianBToken);
      expect(history.status).toBe(200);

      const shared = history.body.results.find((row: { id: string }) => row.id === encounterA);
      expect(shared).toMatchObject({
        hospital: { id: hospitalA.id, name: hospitalA.name, isOwn: false },
        systemOfMedicine: 'ayurveda',
        // Another hospital's staff directory is not shared.
        attending: { id: clinicianA.id, name: null },
      });

      const direct = await get(`/api/v1/encounters/${encounterA}`, clinicianBToken);
      expect(direct.status).toBe(200);

      const audited = await owner<Array<{ action: string; consent: string | null }>>`
        SELECT action, consent_artefact_id AS consent
          FROM access_log
         WHERE actor_id = ${clinicianB.id} AND resource_type = 'encounter'
      ORDER BY at
      `;

      expect(audited.slice(-2)).toEqual([
        { action: 'read', consent: consentId },
        { action: 'read', consent: consentId },
      ]);
    });

    it('does not let another hospital close the encounter it can read', async () => {
      const response = await post(`/api/v1/encounters/${encounterA}/finish`, clinicianBToken);
      expect(response.status).toBe(403);
    });

    it('requires a reason to cancel', async () => {
      const response = await post(`/api/v1/encounters/${encounterA}/cancel`, clinicianAToken, {});
      expect(response.status).toBe(400);
    });

    it('finishes an encounter once', async () => {
      const finished = await post(`/api/v1/encounters/${encounterA}/finish`, clinicianAToken);
      expect(finished.status).toBe(200);
      expect(finished.body.status).toBe('finished');
      expect(new Date(finished.body.endedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(finished.body.startedAt).getTime(),
      );

      const again = await post(`/api/v1/encounters/${encounterA}/finish`, clinicianAToken);
      expect(again.status).toBe(409);
    });
  });

  describe('allergies', () => {
    it('records an allergy at the Ayurvedic hospital', async () => {
      const response = await post('/api/v1/allergies', clinicianAToken, {
        patientId,
        encounterId: encounterA,
        substance: 'Penicillin',
        category: 'medication',
        criticality: 'high',
        reaction: 'Hives and facial swelling',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        substance: 'Penicillin',
        criticality: 'high',
        clinicalStatus: 'active',
        reaction: 'Hives and facial swelling',
        note: null,
        hospital: { id: hospitalA.id, isOwn: true },
        recordedBy: { id: clinicianA.id, name: expect.any(String) },
      });
    });

    it('records one at the allopathic hospital too', async () => {
      const response = await post('/api/v1/allergies', clinicianBToken, {
        patientId,
        substance: 'Peanuts',
        category: 'food',
        criticality: 'low',
      });

      expect(response.status).toBe(201);
    });

    it('refuses an encounter that belongs to a different patient', async () => {
      const otherEncounter = await post('/api/v1/encounters', clinicianAToken, {
        patientId: patientOnlyAtA,
      });

      const response = await post('/api/v1/allergies', clinicianAToken, {
        patientId,
        encounterId: otherEncounter.body.id,
        substance: 'Sulfa',
        category: 'medication',
      });

      expect(response.status).toBe(400);
    });

    it('refuses an allergy with no substance', async () => {
      const response = await post('/api/v1/allergies', clinicianAToken, {
        patientId,
        substance: '   ',
        category: 'food',
      });

      expect(response.status).toBe(400);
    });

    it('shows only the hospital’s own allergies without allergy consent', async () => {
      // B holds consent for encounters only, from the tests above.
      const banner = await get(`/api/v1/patients/${patientId}/allergies`, clinicianBToken);

      expect(banner.status).toBe(200);
      expect(banner.body.sharedFromOtherHospitals).toBe(false);
      expect(banner.body.allergies.map((row: { substance: string }) => row.substance)).toEqual([
        'Peanuts',
      ]);
    });

    it('puts the shared penicillin allergy first once allergies are shared', async () => {
      const consentId = await grantConsent('{allergies}');

      const banner = await get(`/api/v1/patients/${patientId}/allergies`, clinicianBToken);

      expect(banner.status).toBe(200);
      expect(banner.body.sharedFromOtherHospitals).toBe(true);
      expect(
        banner.body.allergies.map((row: { substance: string; hospital: { isOwn: boolean } }) => [
          row.substance,
          row.hospital.isOwn,
        ]),
      ).toEqual([
        ['Penicillin', false],
        ['Peanuts', true],
      ]);
      expect(banner.body.allergies[0].hospital.name).toBe(hospitalA.name);

      const [audited] = await owner<Array<{ consent: string | null }>>`
        SELECT consent_artefact_id AS consent
          FROM access_log
         WHERE actor_id = ${clinicianB.id} AND resource_type = 'allergy_intolerance'
           AND action = 'read'
      ORDER BY at DESC
         LIMIT 1
      `;
      expect(audited?.consent).toBe(consentId);
    });

    it('does not share in the other direction: consent is per grantee', async () => {
      const banner = await get(`/api/v1/patients/${patientId}/allergies`, clinicianAToken);

      expect(banner.body.sharedFromOtherHospitals).toBe(false);
      expect(banner.body.allergies.map((row: { substance: string }) => row.substance)).toEqual([
        'Penicillin',
      ]);
    });

    it('stops sharing the moment consent is revoked', async () => {
      await asSystem(
        (tx) => tx`
        UPDATE consent_artefact
           SET status = 'revoked', revoked_at = now(),
               revoked_by_staff_id = ${frontDeskB.id}, revocation_reason = 'Patient withdrew consent'
         WHERE grantee_hospital_id = ${hospitalB.id} AND status = 'active'
      `,
      );

      const banner = await get(`/api/v1/patients/${patientId}/allergies`, clinicianBToken);

      expect(banner.body.sharedFromOtherHospitals).toBe(false);
      expect(banner.body.allergies.map((row: { substance: string }) => row.substance)).toEqual([
        'Peanuts',
      ]);
    });

    it('refuses the banner for a patient the hospital is not linked to', async () => {
      const response = await get(`/api/v1/patients/${patientOnlyAtA}/allergies`, clinicianBToken);
      expect(response.status).toBe(404);
    });
  });
});
