import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { capabilityStatement } from '../src/modules/fhir/capability-statement';
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
 * `/fhir/R4`: the same record, in the representation other systems read
 * (`planning.md` §10, sp8-plan.md, Phase 6).
 *
 * Two things are being checked, and the second matters more than the first.
 *
 * The first is that it works: resources come back, searches are scoped, the
 * terminology is served, and `$translate` answers with provenance.
 *
 * The second is that **it grants nothing**. A surface that quietly widened
 * access would be the most expensive kind of mistake this system could make,
 * because it would look like a feature. So the tests here check a hospital
 * that has no business with a patient gets nothing, that an unauthenticated
 * client gets nothing, and that the capability statement promises exactly
 * what is routed — no more, and no less.
 */
describe('the FHIR R4 read surface', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let clinician: SeededStaff;
  let otherClinician: SeededStaff;
  let token: string;
  let otherToken: string;

  let patientId: string;
  let encounterId: string;
  let conditionId: string;
  let prescriptionId: string;

  const get = (path: string, as?: string) => {
    const request = ctx.http().get(path);
    return as === undefined ? request : request.set('Authorization', `Bearer ${as}`);
  };

  const post = (path: string, body: Record<string, unknown>, as: string) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${as}`).send(body);

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();

    const seeded = await seedHospital({ name: 'Sanjeevani Ayurveda', mrnPrefix: 'SJT' });
    const elsewhere = await seedHospital({ name: 'Shanti Allopathic', mrnPrefix: 'SHA' });

    clinician = seeded.staff.clinician!;
    otherClinician = elsewhere.staff.clinician!;

    ctx = await createTestApp();
    closers.push(ctx.close);

    token = await signIn(ctx, clinician);
    otherToken = await signIn(ctx, otherClinician);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    const registered = await post(
      '/patients',
      {
        name: 'Kamala Nair',
        gender: 'female',
        dateOfBirth: '1986-07-19',
        phone: '+919812345674',
        forceCreate: true,
      },
      token,
    );

    patientId = (registered.body as { patient: { id: string } }).patient.id;

    encounterId = ((await post('/encounters', { patientId }, token)).body as { id: string }).id;

    conditionId = (
      (
        await post(
          '/diagnoses',
          { encounterId, code: 'DEMO-NAM-001', clinicalStatus: 'active' },
          token,
        )
      ).body as { id: string }
    ).id;

    prescriptionId = (
      (
        await post(
          '/prescriptions',
          {
            encounterId,
            medicineName: 'Avipattikar churna',
            form: 'churna',
            dose: { quantity: 5, unit: 'g' },
            frequency: '1-0-1',
            route: 'oral',
            duration: { value: 30, unit: 'days' },
            startDate: new Date().toISOString().slice(0, 10),
          },
          token,
        )
      ).body as { id: string }
    ).id;

    await post(
      '/notes',
      { encounterId, template: 'general', sections: { subjective: 'Burning after meals' } },
      token,
    );
  }, 120_000);

  afterAll(async () => {
    for (const close of closers) await close();
  });

  describe('what it says about itself', () => {
    it('serves a capability statement without a token', async () => {
      const response = await get('/fhir/R4/metadata');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        resourceType: 'CapabilityStatement',
        status: 'active',
        fhirVersion: '4.0.1',
      });
    });

    it('says the awkward things, where a client will read them', async () => {
      const description = String((await get('/fhir/R4/metadata')).body.description);

      expect(description).toMatch(/read-only/i);
      expect(description).toMatch(/must name a patient/i);
      // The claim this surface must not make.
      expect(description).toMatch(/not claimed/i);
    });

    /**
     * The check worth having: a capability statement is a promise made to a
     * machine, and a machine will believe it. Everything claimed is served,
     * and nothing served is unclaimed.
     */
    it('promises exactly what it serves', async () => {
      const statement = capabilityStatement(new Date()) as {
        rest: Array<{ resource: Array<{ type: string }> }>;
      };

      const claimed = statement.rest[0]!.resource.map((resource) => resource.type);

      for (const type of claimed) {
        const search = await get(`/fhir/R4/${type}?patient=${patientId}&_id=${patientId}`, token);

        // Served: it may answer, or refuse the query, but it is not a 404
        // and it is not "this surface does not serve that".
        expect([200, 400]).toContain(search.status);

        if (search.status === 400) {
          expect(JSON.stringify(search.body)).not.toMatch(/does not serve/);
        }
      }

      const unclaimed = await get(`/fhir/R4/Immunization?patient=${patientId}`, token);
      expect(unclaimed.status).toBe(400);
      expect(JSON.stringify(unclaimed.body)).toMatch(/does not serve Immunization/);
    }, 60_000);
  });

  describe('reading a record through it', () => {
    it('returns a patient with the identifiers the record holds', async () => {
      const response = await get(`/fhir/R4/Patient/${patientId}`, token);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ resourceType: 'Patient', id: patientId });

      const identifiers = (response.body as { identifier: Array<{ system: string }> }).identifier;
      expect(identifiers.some((entry) => entry.system.startsWith('urn:health24:hospital'))).toBe(
        true,
      );
    });

    it('returns a diagnosis with every coding the record holds', async () => {
      const response = await get(`/fhir/R4/Condition/${conditionId}`, token);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ resourceType: 'Condition', id: conditionId });

      const codings = (response.body as { code: { coding: Array<{ code: string }> } }).code.coding;
      expect(codings.some((coding) => coding.code === 'DEMO-NAM-001')).toBe(true);
    });

    it('searches within one patient, and says so when asked without one', async () => {
      const found = await get(`/fhir/R4/MedicationRequest?patient=${patientId}`, token);

      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ resourceType: 'Bundle', type: 'searchset' });

      const ids = (found.body as { entry: Array<{ resource: { id: string } }> }).entry.map(
        (entry) => entry.resource.id,
      );

      expect(ids).toContain(prescriptionId);

      const unscoped = await get('/fhir/R4/MedicationRequest', token);
      expect(unscoped.status).toBe(400);
      expect(JSON.stringify(unscoped.body)).toMatch(/must name a patient/);
    });

    it('accepts a patient reference written either way', async () => {
      const bare = await get(`/fhir/R4/Encounter?patient=${patientId}`, token);
      const referenced = await get(`/fhir/R4/Encounter?patient=Patient/${patientId}`, token);

      expect(bare.status).toBe(200);
      expect(referenced.status).toBe(200);
      expect(referenced.body).toEqual(bare.body);
    });

    it('finds a patient by their hospital number', async () => {
      const [link] = await owner<Array<{ mrn: string }>>`
        SELECT mrn FROM patient_hospital_link WHERE patient_id = ${patientId}
      `;

      const response = await get(`/fhir/R4/Patient?identifier=${link!.mrn}`, token);

      expect(response.status).toBe(200);
      expect((response.body as { total: number }).total).toBe(1);
    });

    /** No resource type here carries a clinician's free text. */
    it('exposes no clinician’s note, by any route', async () => {
      const everything = await Promise.all(
        ['Encounter', 'Condition', 'MedicationRequest', 'Observation', 'DocumentReference'].map(
          (type) => get(`/fhir/R4/${type}?patient=${patientId}`, token),
        ),
      );

      for (const response of everything) {
        expect(JSON.stringify(response.body)).not.toContain('Burning after meals');
      }
    });
  });

  describe('what it refuses', () => {
    it('refuses an unauthenticated clinical read', async () => {
      expect((await get(`/fhir/R4/Patient/${patientId}`)).status).toBe(401);
      expect((await get(`/fhir/R4/Condition?patient=${patientId}`)).status).toBe(401);
    });

    /**
     * The one that matters. The other hospital has never seen this patient
     * and holds no consent, so through this surface — as through every other
     * — they do not exist.
     */
    it('shows another hospital nothing, and does not admit the record exists', async () => {
      const patient = await get(`/fhir/R4/Patient/${patientId}`, otherToken);
      expect(patient.status).toBe(404);

      const condition = await get(`/fhir/R4/Condition/${conditionId}`, otherToken);
      expect(condition.status).toBe(404);

      const searched = await get(`/fhir/R4/Condition?patient=${patientId}`, otherToken);
      expect(searched.status).toBe(200);
      expect((searched.body as { total: number }).total).toBe(0);
    });

    it('refuses a resource this surface does not serve', async () => {
      const response = await get(`/fhir/R4/Practitioner?patient=${patientId}`, token);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ resourceType: 'OperationOutcome' });
    });

    it('answers a missing resource in FHIR’s own words', async () => {
      const response = await get('/fhir/R4/Condition/01a0d7c3-a410-7273-864b-ad9f69444495', token);

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ resourceType: 'OperationOutcome' });
    });
  });

  describe('the terminology, which is the part that is ours', () => {
    it('lists the code systems without unpacking them', async () => {
      const response = await get('/fhir/R4/CodeSystem', token);

      expect(response.status).toBe(200);

      const entries = (
        response.body as { entry: Array<{ resource: Record<string, unknown> }> }
      ).entry;

      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        expect(entry.resource).toMatchObject({ resourceType: 'CodeSystem', content: 'not-present' });
        expect(Number(entry.resource.count)).toBeGreaterThan(0);
      }
    });

    it('says a demo release is experimental, because it is', async () => {
      const response = await get('/fhir/R4/CodeSystem', token);
      const entries = (
        response.body as { entry: Array<{ resource: { experimental: boolean } }> }
      ).entry;

      expect(entries.some((entry) => entry.resource.experimental)).toBe(true);
    });

    it('translates a code, and says where the answer came from', async () => {
      const response = await get(
        '/fhir/R4/ConceptMap/$translate?system=namaste&code=DEMO-NAM-001',
        token,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ resourceType: 'Parameters' });

      const parameters = (
        response.body as {
          parameter: Array<{ name: string; valueBoolean?: boolean; part?: Array<{ name: string }> }>;
        }
      ).parameter;

      expect(parameters[0]).toMatchObject({ name: 'result', valueBoolean: true });

      const match = parameters.find((parameter) => parameter.name === 'match');
      const partNames = (match?.part ?? []).map((part) => part.name);

      // A code without its equivalence and its source is a code somebody has
      // to guess the provenance of.
      expect(partNames).toContain('equivalence');
      expect(partNames).toContain('concept');
      expect(partNames).toContain('source');
    });

    it('needs terminology permission, like the rest of the terminology', async () => {
      // The front desk reads patients but not the vocabulary.
      const seeded = await seedHospital({ name: 'Desk Only', mrnPrefix: 'DSK' });
      const deskToken = await signIn(ctx, seeded.staff.frontDesk!);

      expect((await get('/fhir/R4/CodeSystem', deskToken)).status).toBe(403);
    });
  });

  describe('what it writes down', () => {
    it('audits a read here exactly as a read anywhere else', async () => {
      await get(`/fhir/R4/Condition/${conditionId}`, token);

      const [row] = await owner<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM access_log
         WHERE resource_type = 'condition'
           AND resource_id = ${conditionId}
           AND action = 'read'
           AND route LIKE '%fhir%'
      `;

      expect(row?.count ?? 0).toBeGreaterThan(0);
    });
  });
});
