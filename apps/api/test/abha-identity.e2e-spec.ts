import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { MOCK_ABHA_CODE } from '../src/modules/abdm/abha-verification.mock';
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
 * ABHA identity, and the difference between a confirmed one and a typed one
 * (sp8-plan.md, Phase 1).
 *
 * The distinction is the whole of this suite. Before SP8 the two were one
 * column and matching treated both as certainty; these tests hold the line in
 * three places at once — the API refuses to edit a confirmed identifier, the
 * database refuses to invent one, and the matcher refuses to conclude from a
 * typed one.
 *
 * ABDM is mocked (`ABDM_MODE` defaults to `mock` outside production, and is
 * refused in it), so no credential and no network are involved.
 */
describe('ABHA identity', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let app: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let hospital: { id: string; mrnPrefix: string };
  let elsewhere: { id: string };
  let frontDesk: SeededStaff;
  let token: string;
  let elsewhereToken: string;

  const ABHA = '11112222333344';
  const ADDRESS = 'lakshmi.devi@abdm';

  const get = (path: string, as = token) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${as}`);

  const post = (path: string, body: Record<string, unknown> = {}, as = token) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${as}`).send(body);

  const patch = (path: string, body: Record<string, unknown>, as = token) =>
    ctx.http().patch(`/api/v1${path}`).set('Authorization', `Bearer ${as}`).send(body);

  /** A patient registered at the fixture hospital, with whatever identity is given. */
  async function register(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const response = await post('/patients', {
      name,
      gender: 'female',
      dateOfBirth: '1988-04-12',
      forceCreate: true,
      ...extra,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { id: (response.body as { patient: { id: string } }).patient.id };
  }

  /** Walks the two steps, with the patient reading the mock's code back. */
  async function verify(
    patientId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const started = await post(`/patients/${patientId}/abha/verification`, {
      method: 'mobile_otp',
      ...body,
    });

    expect(started.status, JSON.stringify(started.body)).toBe(201);

    const confirmed = await post(`/patients/${patientId}/abha/verification/confirm`, {
      transactionId: (started.body as { transactionId: string }).transactionId,
      code: MOCK_ABHA_CODE,
    });

    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    return confirmed.body as Record<string, unknown>;
  }

  beforeAll(async () => {
    await resetDatabase();

    const seeded = await seedHospital({ name: 'Sanjeevani Ayurveda', mrnPrefix: 'SJT' });
    const other = await seedHospital({ name: 'Shanti Allopathic', mrnPrefix: 'SHA' });
    elsewhere = other.hospital;
    hospital = seeded.hospital;
    frontDesk = seeded.staff.frontDesk!;

    ctx = await createTestApp();
    closers.push(ctx.close);

    token = await signIn(ctx, frontDesk);
    elsewhereToken = await signIn(ctx, other.staff.frontDesk!);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);
  });

  /**
   * As the unprivileged application role, inside the fixture hospital's
   * context — which is how these guarantees are reached in production, and
   * the only way to prove the database refuses what the API refuses.
   */
  async function asHospital<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_hospital_id', ${hospital.id}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  afterAll(async () => {
    for (const close of closers) await close();
  });

  describe('what registration can and cannot claim', () => {
    it('records a typed ABHA, and does not call it verified', async () => {
      const patient = await register('Sunita Rao', { abhaNumber: '99998888777766' });

      const summary = await get(`/patients/${patient.id}`);

      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({
        abhaNumber: '99998888777766',
        abhaVerified: false,
      });
    });

    it('refuses a registration that claims the ABHA is already verified', async () => {
      // Not through the API — no route offers it — but through the database,
      // which is where the guarantee has to live. A future service that set
      // the column directly would be refused in exactly this way.
      await expect(
        asHospital(
          async (tx) => tx`
            INSERT INTO patient
              (name, name_normalized, gender, created_by_hospital_id,
               abha_number, abha_number_verified_at, abha_verification_method)
            VALUES ('Forged Identity', 'forged identity', 'female', ${hospital.id},
                    '12121212121212', now(), 'mobile_otp')
          `,
        ),
      ).rejects.toThrow(/already marked verified/);
    });
  });

  describe('verifying, with the patient present', () => {
    it('confirms an ABHA and records how and when', async () => {
      const patient = await register('Lakshmi Devi');

      const identity = await verify(patient.id, { abhaAddress: ADDRESS });

      expect(identity).toMatchObject({
        abhaAddress: ADDRESS,
        verified: true,
        verificationMethod: 'mobile_otp',
      });
      expect(identity.addressVerifiedAt).toBeTruthy();
      // Only what the registry confirmed. The mock was given an address, and
      // it does not invent a number to go with it.
      expect(identity.abhaNumber).toBeNull();

      const summary = await get(`/patients/${patient.id}`);
      expect(summary.body).toMatchObject({ abhaAddress: ADDRESS, abhaVerified: true });
    });

    it('records who was standing there', async () => {
      const patient = await register('Anita Shah');
      await verify(patient.id, { abhaNumber: ABHA });

      const [row] = await owner<Array<{ abha_verified_by_staff_id: string }>>`
        SELECT abha_verified_by_staff_id FROM patient WHERE id = ${patient.id}
      `;

      expect(row?.abha_verified_by_staff_id).toBe(frontDesk.id);
    });

    it('writes nothing when the code is wrong', async () => {
      const patient = await register('Wrong Code');

      const started = await post(`/patients/${patient.id}/abha/verification`, {
        abhaNumber: '55556666777788',
        method: 'mobile_otp',
      });

      const refused = await post(`/patients/${patient.id}/abha/verification/confirm`, {
        transactionId: (started.body as { transactionId: string }).transactionId,
        code: '999999',
      });

      expect(refused.status).toBe(401);

      const identity = await get(`/patients/${patient.id}/abha`);
      expect(identity.body).toMatchObject({ abhaNumber: null, verified: false });
    });

    it('will not answer the same challenge twice', async () => {
      const patient = await register('Replayed Challenge');

      const started = await post(`/patients/${patient.id}/abha/verification`, {
        abhaNumber: '44445555666677',
        method: 'mobile_otp',
      });

      const transactionId = (started.body as { transactionId: string }).transactionId;

      const first = await post(`/patients/${patient.id}/abha/verification/confirm`, {
        transactionId,
        code: MOCK_ABHA_CODE,
      });
      expect(first.status).toBe(201);

      const second = await post(`/patients/${patient.id}/abha/verification/confirm`, {
        transactionId,
        code: MOCK_ABHA_CODE,
      });
      expect(second.status).toBe(410);
    });

    it('refuses an ABHA another record already holds, and says why', async () => {
      const first = await register('Holds The Number');
      await verify(first.id, { abhaNumber: '77778888999900' });

      const second = await register('Wants The Same Number');

      const started = await post(`/patients/${second.id}/abha/verification`, {
        abhaNumber: '77778888999900',
        method: 'mobile_otp',
      });

      const clash = await post(`/patients/${second.id}/abha/verification/confirm`, {
        transactionId: (started.body as { transactionId: string }).transactionId,
        code: MOCK_ABHA_CODE,
      });

      // A conflict a person resolves, not a 500 they report.
      expect(clash.status).toBe(409);
      expect(JSON.stringify(clash.body)).toMatch(/already holds/i);
    });

    /**
     * Found by the browser tests, which drive a patient registered at one
     * hospital and seen at another: SP1 lets a hospital write only a patient
     * it created, and confirming an ABHA is done by whichever hospital they
     * walked into (migration 0076).
     */
    it('can be done by a hospital the patient did not register at', async () => {
      const patient = await register('Registered Elsewhere');

      // The other hospital sees her because she is linked to it, not because
      // it created her.
      await owner`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
        VALUES (${patient.id}, ${elsewhere.id}, 'SHA-000099')
      `;

      const started = await post(
        `/patients/${patient.id}/abha/verification`,
        { abhaNumber: '13131313131313', method: 'mobile_otp' },
        elsewhereToken,
      );

      expect(started.status, JSON.stringify(started.body)).toBe(201);

      const confirmed = await post(
        `/patients/${patient.id}/abha/verification/confirm`,
        {
          transactionId: (started.body as { transactionId: string }).transactionId,
          code: MOCK_ABHA_CODE,
        },
        elsewhereToken,
      );

      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
      expect(confirmed.body).toMatchObject({ verified: true });
    });

    it('is on the audit trail, so the patient can see it was asked about', async () => {
      const patient = await register('Audited Verification');
      await verify(patient.id, { abhaNumber: '33334444555566' });

      const rows = await owner<Array<{ action: string }>>`
        SELECT action
          FROM access_log
         WHERE patient_id = ${patient.id}
           AND actor_id = ${frontDesk.id}
      `;

      const actions = rows.map((row) => row.action);

      // Asking the registry is a read of the patient's identity; recording
      // what it said is a change to their record. Both are on the trail.
      expect(actions).toContain('read');
      expect(actions).toContain('update');
    });
  });

  describe('once it is verified', () => {
    it('cannot be edited through the demographic-correction route', async () => {
      const patient = await register('Frozen Identity');
      await verify(patient.id, { abhaNumber: '22223333444455' });

      const attempt = await patch(`/patients/${patient.id}`, {
        abhaNumber: '66667777888899',
        reason: 'The patient gave a different number',
      });

      expect(attempt.status).toBe(409);
      expect(JSON.stringify(attempt.body)).toMatch(/verified/i);
    });

    it('cannot be edited at the database either', async () => {
      const patient = await register('Frozen At The Database');
      await verify(patient.id, { abhaNumber: '88889999000011' });

      await expect(
        asHospital(
          async (tx) =>
            tx`UPDATE patient SET abha_number = '10101010101010' WHERE id = ${patient.id}`,
        ),
      ).rejects.toThrow(/verified ABHA number cannot be edited/);
    });

    it('cannot have its verification quietly withdrawn', async () => {
      const patient = await register('Standing Verification');
      await verify(patient.id, { abhaNumber: '12341234123412' });

      await expect(
        asHospital(
          async (tx) => tx`
            UPDATE patient
               SET abha_number_verified_at = NULL, abha_verification_method = NULL
             WHERE id = ${patient.id}
          `,
        ),
      ).rejects.toThrow(/record_abha_verification/);
    });

    it('lets a demographic correction change everything else', async () => {
      const patient = await register('Other Fields');
      await verify(patient.id, { abhaNumber: '56785678567856' });

      const corrected = await patch(`/patients/${patient.id}`, {
        phone: '+919812345699',
        reason: 'New number given by the patient',
      });

      expect(corrected.status).toBe(200);
      expect(corrected.body).toMatchObject({ abhaVerified: true });
    });
  });

  describe('what matching does with each kind', () => {
    /**
     * The registration this changes. A typed ABHA that matches an existing
     * record used to link the two without asking anybody; now it puts the
     * pairing in front of a human, which is what the review queue is for.
     */
    it('does not link a new registration on a typed ABHA alone', async () => {
      const existing = await register('Kamala Nair');
      await verify(existing.id, { abhaNumber: '19191919191919' });

      // The same number typed at the desk for somebody the matcher can still
      // recognise. Before SP8 this linked the two records outright.
      const response = await post('/patients', {
        name: 'Kamala Nair',
        gender: 'female',
        dateOfBirth: '1988-04-12',
        abhaNumber: '19191919191919',
      });

      expect(response.status).toBe(409);
      expect((response.body as { code?: string }).code).toBe('POSSIBLE_DUPLICATE');
    });

    it('shows the reviewer that the ABHA agreement was only declared', async () => {
      const lookup = await post('/patients/lookup', {
        name: 'Kamala Nair',
        abhaNumber: '19191919191919',
      });

      expect(lookup.status).toBe(201);

      const { candidates } = lookup.body as {
        candidates: Array<{ matchedOn: string[]; score: number }>;
      };

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]?.matchedOn).toContain('abha_number_declared');
    });

    /**
     * And the case the matcher cannot catch: everything disagrees except the
     * number, so nothing is offered for review and the unique index is the
     * first thing to object. That used to be a 500.
     */
    it('refuses a registration whose ABHA belongs to another record', async () => {
      const response = await post('/patients', {
        name: 'Nobody By This Name At All',
        gender: 'male',
        approximateAgeYears: 3,
        abhaNumber: '19191919191919',
      });

      expect(response.status).toBe(409);
      expect((response.body as { code?: string }).code).toBe('ABHA_ALREADY_REGISTERED');
    });
  });

  describe('merging two records that both carry one', () => {
    it('refuses when each holds a different verified ABHA', async () => {
      const first = await register('Twin One');
      const second = await register('Twin Two');

      await verify(first.id, { abhaNumber: '61616161616161' });
      await verify(second.id, { abhaNumber: '62626262626262' });

      const [candidate] = await owner<Array<{ id: string }>>`
        INSERT INTO patient_merge_candidate
          (patient_a_id, patient_b_id, detected_by_hospital_id, score, method,
           matched_on, status)
        VALUES (${first.id}, ${second.id}, ${hospital.id}, 0.9, 'probabilistic',
                '{name}'::text[], 'pending')
        RETURNING id
      `;

      const refused = await post(`/patients/merge-queue/${candidate!.id}/resolve`, {
        decision: 'merge',
        keepPatientId: first.id,
        reason: 'They looked like the same person',
      });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toMatch(/ABDM/);
    });
  });
});
