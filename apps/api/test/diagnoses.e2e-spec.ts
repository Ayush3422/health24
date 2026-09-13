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
 * Diagnoses: a NAMASTE term reaching a patient's record with its dual coding.
 *
 * Runs on the synthetic demo terminology. The demo NAMASTE → TM2 map is
 * authoritative, so DEMO-NAM-001 (Amlapitta) translates on import; its
 * biomedical mapping arrives proposed, so no advisory code attaches until a
 * curator approves it — which one test does, to prove the snapshot survives
 * that mapping being retired afterwards.
 */
describe('diagnoses', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalA: { id: string; name: string };
  let hospitalB: { id: string };
  let clinicianA: SeededStaff;
  let clinicianB: SeededStaff;
  let frontDeskB: SeededStaff;
  let tokenA: string;
  let tokenB: string;

  let patientId: string;
  let encounterId: string;

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  async function asSystem<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  async function mmsElementFor(sourceCode: string): Promise<string> {
    const [row] = await owner<Array<{ id: string }>>`
      SELECT e.id
        FROM concept_map_element e
        JOIN concept_map m ON m.id = e.concept_map_id
        JOIN code_system t ON t.id = m.target_system_id
       WHERE t.key = 'icd11-mms' AND e.source_code = ${sourceCode}
    `;

    return row!.id;
  }

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Diagnosis Test', mrnPrefix: 'SDT' });
    const b = await seedHospital({
      name: 'City General Diagnosis Test',
      mrnPrefix: 'GDT',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital;
    hospitalB = b.hospital;
    clinicianA = a.staff.clinician as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;

    tokenA = await signIn(ctx, clinicianA);
    tokenB = await signIn(ctx, clinicianB);

    const registered = await post(
      '/patients',
      await signIn(ctx, a.staff.frontDesk as SeededStaff),
      {
        name: 'Kamala Diagnosis',
        gender: 'female',
        dateOfBirth: '1969-08-21',
        phone: '9820055551',
      },
    );
    patientId = registered.body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await asSystem(
      (tx) => tx`
      INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
      VALUES (${patientId}, ${hospitalB.id}, 'GDT-000001')
    `,
    );

    const encounter = await post('/encounters', tokenA, { patientId });
    encounterId = encounter.body.id;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  describe('recording', () => {
    it('records Amlapitta with its TM2 translation attached', async () => {
      const response = await post('/diagnoses', tokenA, {
        encounterId,
        code: 'DEMO-NAM-001',
        isPrimary: true,
        onsetDate: '2026-05-01',
        note: 'Worse after spicy food',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        patientId,
        encounterId,
        isPrimary: true,
        clinicalStatus: 'active',
        verificationStatus: 'confirmed',
        onsetDate: '2026-05-01',
        note: 'Worse after spicy food',
        hospital: { id: hospitalA.id, isOwn: true },
        recordedBy: { id: clinicianA.id },
        codings: {
          primary: {
            role: 'primary',
            system: 'namaste',
            code: 'DEMO-NAM-001',
            display: 'Amlapitta',
            equivalence: null,
            conceptMapElementId: null,
          },
          translated: {
            role: 'translated',
            system: 'icd11-tm2',
            code: 'DEMO-TM2-01',
            equivalence: 'equivalent',
            conceptMapElementId: expect.any(String),
          },
          // The biomedical mapping is still awaiting review.
          advisory: null,
        },
      });

      // Anything not attached is explained, never silently absent.
      expect(response.body.codingNotes.length).toBeGreaterThan(0);
    });

    it('refuses a second primary diagnosis on the same encounter', async () => {
      const response = await post('/diagnoses', tokenA, {
        encounterId,
        code: 'DEMO-NAM-002',
        isPrimary: true,
      });

      expect(response.status).toBe(409);
    });

    it('snapshots the advisory code, so retiring the mapping later changes nothing', async () => {
      const elementId = await mmsElementFor('DEMO-NAM-001');

      await asSystem(
        (tx) => tx`
        UPDATE concept_map_element SET status = 'approved', reviewed_at = now() WHERE id = ${elementId}
      `,
      );

      const recorded = await post('/diagnoses', tokenA, {
        encounterId,
        code: 'DEMO-NAM-001',
        verificationStatus: 'provisional',
      });

      expect(recorded.status).toBe(201);
      expect(recorded.body.codings.advisory).toMatchObject({
        role: 'advisory',
        system: 'icd11-mms',
        code: 'DEMO-MMS-01',
        equivalence: 'wider',
        conceptMapElementId: elementId,
      });

      await asSystem(
        (tx) => tx`
        UPDATE concept_map_element SET status = 'retired' WHERE id = ${elementId}
      `,
      );

      const listed = await get(`/encounters/${encounterId}/diagnoses`, tokenA);
      const same = listed.body.find((row: { id: string }) => row.id === recorded.body.id);

      expect(same.codings.advisory).toMatchObject({
        code: 'DEMO-MMS-01',
        conceptMapElementId: elementId,
      });

      // A new diagnosis made now no longer receives it.
      const after = await post('/diagnoses', tokenA, { encounterId, code: 'DEMO-NAM-001' });
      expect(after.body.codings.advisory).toBeNull();
    });

    it('never attaches an inexact biomedical correspondence', async () => {
      const elementId = await mmsElementFor('DEMO-NAM-002');

      await asSystem(
        (tx) => tx`
        UPDATE concept_map_element SET status = 'approved', reviewed_at = now() WHERE id = ${elementId}
      `,
      );

      const response = await post('/diagnoses', tokenA, { encounterId, code: 'DEMO-NAM-002' });

      expect(response.status).toBe(201);
      expect(response.body.codings.advisory).toBeNull();
    });

    it('refuses a code that is not in the vocabulary', async () => {
      const response = await post('/diagnoses', tokenA, { encounterId, code: 'NOT-A-CODE' });
      expect(response.status).toBe(400);
    });

    it('refuses a vocabulary with no active release', async () => {
      const response = await post('/diagnoses', tokenA, {
        encounterId,
        system: 'unknown-system',
        code: 'DEMO-NAM-001',
      });
      expect(response.status).toBe(400);
    });

    it('refuses an onset date in the future', async () => {
      const response = await post('/diagnoses', tokenA, {
        encounterId,
        code: 'DEMO-NAM-001',
        onsetDate: '2999-01-01',
      });
      expect(response.status).toBe(400);
    });

    it('refuses a cancelled encounter', async () => {
      const opened = await post('/encounters', tokenA, { patientId });
      await post(`/encounters/${opened.body.id}/cancel`, tokenA, { reason: 'Opened in error' });

      const response = await post('/diagnoses', tokenA, {
        encounterId: opened.body.id,
        code: 'DEMO-NAM-001',
      });

      expect(response.status).toBe(409);
    });

    it('refuses another hospital’s encounter: 404 unseen, 403 once consent reveals it', async () => {
      const unseen = await post('/diagnoses', tokenB, { encounterId, code: 'DEMO-NAM-001' });
      expect(unseen.status).toBe(404);

      await asSystem(
        (tx) => tx`
        INSERT INTO consent_artefact
          (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method, recorded_by_staff_id)
        VALUES (${patientId}, ${hospitalB.id}, '{encounters}', now() + interval '30 days',
                'signed_form', ${frontDeskB.id})
      `,
      );

      const seen = await post('/diagnoses', tokenB, { encounterId, code: 'DEMO-NAM-001' });
      expect(seen.status).toBe(403);
    });
  });

  describe('problem list', () => {
    it('lists active diagnoses and leaves out resolved ones', async () => {
      const resolved = await post('/diagnoses', tokenA, {
        encounterId,
        code: 'DEMO-NAM-004',
        clinicalStatus: 'resolved',
      });
      expect(resolved.status).toBe(201);

      const response = await get(`/patients/${patientId}/problems`, tokenA);

      expect(response.status).toBe(200);
      expect(response.body.sharedFromOtherHospitals).toBe(false);

      const ids = response.body.problems.map((row: { id: string }) => row.id);
      expect(ids).not.toContain(resolved.body.id);
      expect(
        response.body.problems.every(
          (row: { clinicalStatus: string }) => row.clinicalStatus === 'active',
        ),
      ).toBe(true);
    });

    it('shows another hospital nothing without diagnosis consent', async () => {
      // B holds consent for encounters only, from the test above.
      const response = await get(`/patients/${patientId}/problems`, tokenB);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ problems: [], sharedFromOtherHospitals: false });

      const forEncounter = await get(`/encounters/${encounterId}/diagnoses`, tokenB);
      expect(forEncounter.status).toBe(200);
      expect(forEncounter.body).toEqual([]);
    });

    it('shows the Ayurvedic diagnosis with its TM2 code under consent, and audits it', async () => {
      const [consent] = await asSystem(
        (tx) => tx<Array<{ id: string }>>`
        INSERT INTO consent_artefact
          (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method, recorded_by_staff_id)
        VALUES (${patientId}, ${hospitalB.id}, '{diagnoses}', now() + interval '30 days',
                'signed_form', ${frontDeskB.id})
        RETURNING id
      `,
      );

      const response = await get(`/patients/${patientId}/problems`, tokenB);

      expect(response.status).toBe(200);
      expect(response.body.sharedFromOtherHospitals).toBe(true);

      const amlapitta = response.body.problems.find((row: { isPrimary: boolean }) => row.isPrimary);

      expect(amlapitta).toMatchObject({
        hospital: { id: hospitalA.id, name: hospitalA.name, isOwn: false },
        recordedBy: { id: clinicianA.id, name: null },
        codings: {
          primary: { system: 'namaste', display: 'Amlapitta' },
          translated: { system: 'icd11-tm2', code: 'DEMO-TM2-01' },
        },
      });

      const [audited] = await owner<Array<{ consent: string | null }>>`
        SELECT consent_artefact_id AS consent
          FROM access_log
         WHERE actor_id = ${clinicianB.id} AND resource_type = 'condition' AND action = 'read'
      ORDER BY at DESC
         LIMIT 1
      `;
      expect(audited?.consent).toBe(consent!.id);
    });

    it('refuses the problem list for a patient the hospital does not know', async () => {
      const response = await get('/patients/00000000-0000-4000-8000-000000000000/problems', tokenA);
      expect(response.status).toBe(404);
    });
  });
});
