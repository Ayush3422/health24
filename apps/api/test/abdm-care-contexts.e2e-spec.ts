import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  MOCK_GATEWAY_CODE,
  MockGatewayServer,
} from '../src/modules/abdm/gateway/mock-gateway';
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
 * Care contexts: offering a patient's visits to the national network, and
 * being asked about them (sp8-plan.md, Phase 3).
 *
 * Both directions are here, because they are different acts. The desk offers
 * and the gateway sends the code; the patient asks from their own app and
 * **this system** sends the code, because no member of staff is involved and
 * nothing else proves the person holding the app is the person in the record.
 *
 * The suite that matters most is the middle one. Discovery is the only place
 * where an outsider asks after a patient by name, and everything in it is
 * arranged so that a caller who does not already know a verified ABHA address
 * learns nothing at all — including whether the person exists.
 */
describe('ABDM care contexts', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let app: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let gateway: MockGatewayServer;
  let hospital: { id: string };
  let other: { id: string };
  let frontDesk: SeededStaff;
  let clinician: SeededStaff;
  let otherFrontDesk: SeededStaff;
  let token: string;
  let clinicianToken: string;
  let otherToken: string;

  const HIP_ID = 'HFR-CARE-CONTEXTS-0001';
  const CALLBACK_SECRET = 'a-shared-secret-for-callbacks';
  const ABHA = 'kamala.nair@abdm';
  const PHONE = '+919812345671';

  let patientId: string;
  let encounterId: string;
  let secondEncounterId: string;

  const before: Record<string, string | undefined> = {};

  const post = (path: string, body: Record<string, unknown> = {}, as = token) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${as}`).send(body);

  const get = (path: string, as = token) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${as}`);

  /** A visit at the fixture hospital. Opened by the clinician, not the desk. */
  async function openVisit(forPatient: string): Promise<string> {
    const response = await post('/encounters', { patientId: forPatient }, clinicianToken);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { id: string }).id;
  }

  /** Marks an ABHA verified the way the verification flow does. */
  async function verifyAbha(id: string, address: string): Promise<void> {
    await owner`
      SELECT app.record_abha_verification(
        ${id}::uuid, NULL, ${address}, 'mobile_otp'::abha_verification_method, NULL
      )
    `;
  }


  beforeAll(async () => {
    await resetDatabase();

    const seeded = await seedHospital({ name: 'Sanjeevani Ayurveda', mrnPrefix: 'SJT' });
    hospital = seeded.hospital;
    frontDesk = seeded.staff.frontDesk!;
    clinician = seeded.staff.clinician!;

    const elsewhere = await seedHospital({ name: 'Shanti Allopathic', mrnPrefix: 'SHA' });
    other = elsewhere.hospital;
    otherFrontDesk = elsewhere.staff.frontDesk!;

    gateway = new MockGatewayServer({
      clientId: 'health24-under-test',
      clientSecret: 'not-a-real-client-secret',
      callbackSecret: CALLBACK_SECRET,
    });

    await gateway.start();
    closers.push(() => gateway.stop());

    for (const [key, value] of Object.entries({
      ABDM_MODE: 'gateway',
      ABDM_GATEWAY_URL: gateway.url,
      ABDM_CLIENT_ID: 'health24-under-test',
      ABDM_CLIENT_SECRET: 'not-a-real-client-secret',
      ABDM_HIP_ID: 'HFR-DEPLOYMENT-DEFAULT',
      ABDM_CM_ID: 'sbx',
      ABDM_CALLBACK_SECRET: CALLBACK_SECRET,
      ABDM_CALL_TIMEOUT_MS: '5000',
    })) {
      before[key] = process.env[key];
      process.env[key] = value;
    }

    ctx = await createTestApp();
    closers.push(ctx.close);

    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as AddressInfo;
    gateway.callbackBaseUrl = `http://127.0.0.1:${String(address.port)}`;

    token = await signIn(ctx, frontDesk);
    // Opening an encounter is clinical work; the desk cannot do it.
    clinicianToken = await signIn(ctx, clinician);
    otherToken = await signIn(ctx, otherFrontDesk);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);

    // This facility is registered with ABDM; the other deliberately is not.
    await owner`UPDATE hospital SET hfr_id = ${HIP_ID} WHERE id = ${hospital.id}`;

    const registered = await post('/patients', {
      name: 'Kamala Nair',
      gender: 'female',
      dateOfBirth: '1986-07-19',
      phone: PHONE,
      forceCreate: true,
    });

    patientId = (registered.body as { patient: { id: string } }).patient.id;
    await verifyAbha(patientId, ABHA);

    encounterId = await openVisit(patientId);
    secondEncounterId = await openVisit(patientId);
  });

  afterAll(async () => {
    for (const close of closers) await close();

    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('what the desk sees and offers', () => {
    it('lists the visits, and says none of them is shared yet', async () => {
      const response = await get(`/patients/${patientId}/care-contexts`);

      expect(response.status).toBe(200);

      const visits = response.body as Array<{ encounterId: string; status: string | null }>;
      expect(visits).toHaveLength(2);
      expect(visits.every((visit) => visit.status === null)).toBe(true);
    });

    it('describes a visit without saying anything clinical about it', async () => {
      const response = await get(`/patients/${patientId}/care-contexts`);
      const visits = response.body as Array<{ display: string }>;

      for (const visit of visits) {
        expect(visit.display).toMatch(/OPD visit, \d{1,2} \w{3,4} \d{4} · Sanjeevani Ayurveda/);
      }
    });

    it('links nothing until the patient answers the code', async () => {
      const offered = await post(`/patients/${patientId}/care-contexts/link`, {
        encounterIds: [encounterId],
      });

      expect(offered.status).toBe(201);
      expect(offered.body).toMatchObject({ sentTo: 'XXXXXXXX99' });

      const midway = await get(`/patients/${patientId}/care-contexts`);
      const visit = (midway.body as Array<{ encounterId: string; status: string | null }>).find(
        (entry) => entry.encounterId === encounterId,
      );

      expect(visit?.status).toBeNull();

      const confirmed = await post(`/patients/${patientId}/care-contexts/link/confirm`, {
        linkRequestId: (offered.body as { linkRequestId: string }).linkRequestId,
        code: MOCK_GATEWAY_CODE,
      });

      expect(confirmed.status).toBe(201);

      const after = await get(`/patients/${patientId}/care-contexts`);
      const linked = (after.body as Array<{ encounterId: string; status: string | null }>).find(
        (entry) => entry.encounterId === encounterId,
      );

      expect(linked?.status).toBe('linked');
    });

    it('refuses a wrong code, and leaves the visit unshared', async () => {
      const offered = await post(`/patients/${patientId}/care-contexts/link`, {
        encounterIds: [secondEncounterId],
      });

      const refused = await post(`/patients/${patientId}/care-contexts/link/confirm`, {
        linkRequestId: (offered.body as { linkRequestId: string }).linkRequestId,
        code: '111111',
      });

      expect(refused.status).toBe(401);

      const [row] = await owner<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM abdm_care_context
         WHERE encounter_id = ${secondEncounterId}
      `;

      expect(row?.count).toBe(0);
    });

    it('will not offer the same visit twice', async () => {
      const response = await post(`/patients/${patientId}/care-contexts/link`, {
        encounterIds: [encounterId],
      });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toMatch(/already shared/i);
    });

    it('will not link a patient whose ABHA nobody has confirmed', async () => {
      const registered = await post('/patients', {
        name: 'Unverified Person',
        gender: 'male',
        approximateAgeYears: 40,
        abhaAddress: 'typed.by.the.desk@abdm',
        forceCreate: true,
      });

      const unverified = (registered.body as { patient: { id: string } }).patient.id;
      const visit = await openVisit(unverified);

      const response = await post(`/patients/${unverified}/care-contexts/link`, {
        encounterIds: [visit],
      });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toMatch(/verified ABHA/i);
    });
  });

  describe('being asked whether we hold anything', () => {
    const discover = (
      body: Record<string, unknown>,
      options: { hipId?: string; secret?: string | null } = {},
    ) =>
      gateway.ask(
        'care-context.discover',
        options.hipId ?? HIP_ID,
        { transactionId: `txn-${String(Math.random())}`, ...body },
        options.secret === undefined ? {} : { secret: options.secret },
      );

    /** The answer this system sent back for the most recent discovery. */
    const answerFor = async (index: number) => {
      const seen = gateway.received.filter((entry) => entry.path.endsWith('on-discover'));

      for (let attempt = 0; attempt < 200 && seen.length <= index; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        seen.length = 0;
        seen.push(...gateway.received.filter((entry) => entry.path.endsWith('on-discover')));
      }

      return seen[index]?.body as Record<string, unknown> | undefined;
    };

    it('answers with the patient and the visits they have not shared yet', async () => {
      const seenBefore = gateway.received.filter((e) => e.path.endsWith('on-discover')).length;

      const response = await discover({
        patient: { id: ABHA, name: 'Kamala Nair', gender: 'F', yearOfBirth: 1986 },
      });

      expect(response.status).toBe(202);

      const answer = await answerFor(seenBefore);
      const patient = answer?.patient as
        | { patientReference: string; careContexts: Array<{ display: string }> }
        | undefined;

      expect(patient?.patientReference).toBe(patientId);
      // The visit already linked above is not offered again.
      expect(patient?.careContexts.map((context) => context.display)).toHaveLength(1);
      expect(patient?.careContexts[0]?.display).toContain('Sanjeevani Ayurveda');
    });

    it('records that the patient was looked for, so they can see it', async () => {
      const [row] = await owner<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM access_log
         WHERE patient_id = ${patientId}
           AND actor_type = 'system'
           AND resource_type = 'abdm_care_context'
           AND action = 'search'
      `;

      expect(row?.count ?? 0).toBeGreaterThan(0);
    });

    /**
     * The three refusals that matter, and the point is that they are one
     * refusal: a caller must not be able to tell "no such person" from "that
     * person, but you got their year of birth wrong".
     */
    it('answers identically whether the person is unknown, unverified or contradicted', async () => {
      const seenBefore = gateway.received.filter((e) => e.path.endsWith('on-discover')).length;

      await discover({ patient: { id: 'nobody.at.all@abdm', name: 'Nobody' } });
      await discover({ patient: { id: 'typed.by.the.desk@abdm', name: 'Unverified Person' } });
      await discover({
        patient: { id: ABHA, name: 'Kamala Nair', yearOfBirth: 1955 },
      });

      const answers = [
        await answerFor(seenBefore),
        await answerFor(seenBefore + 1),
        await answerFor(seenBefore + 2),
      ];

      for (const answer of answers) {
        expect(answer?.error).toMatchObject({ message: 'No patient found' });
        expect(answer?.patient).toBeUndefined();
      }

      // Byte for byte the same, but for the correlation and the timestamp.
      const shapes = answers.map((answer) => JSON.stringify(answer?.error));
      expect(new Set(shapes).size).toBe(1);
    });

    it('refuses a caller that cannot prove who it is', async () => {
      const response = await discover(
        { patient: { id: ABHA, name: 'Kamala Nair' } },
        { secret: 'not-the-secret' },
      );

      expect(response.status).toBe(401);
    });

    it('refuses to answer for a facility this deployment does not know', async () => {
      const seenBefore = gateway.received.filter((e) => e.path.endsWith('on-discover')).length;

      await discover({ patient: { id: ABHA, name: 'Kamala Nair' } }, { hipId: 'HFR-SOMEBODY-ELSE' });

      const answer = await answerFor(seenBefore);
      expect(answer?.error).toMatchObject({ message: 'No patient found' });
    });
  });

  describe('when the patient asks from their own app', () => {
    it('sends them a code, and links only once they answer it', async () => {
      const seenBefore = gateway.received.filter((e) => e.path.endsWith('on-init')).length;

      const started = await gateway.ask('care-context.link.inbound-init', HIP_ID, {
        transactionId: 'txn-patient-initiated',
        patient: {
          referenceNumber: patientId,
          careContexts: [{ referenceNumber: secondEncounterId }],
        },
      });

      expect(started.status).toBe(202);

      const onInit = await gateway.waitForAnswer('on-init');
      const link = onInit.link as { referenceNumber: string; meta: { communicationHint: string } };

      expect(link.referenceNumber).toBeTruthy();
      // Masked: enough for the patient to recognise their own number.
      expect(link.meta.communicationHint).not.toContain('9812345671');
      expect(seenBefore).toBeLessThan(
        gateway.received.filter((e) => e.path.endsWith('on-init')).length,
      );

      const sms = ctx.app.get(LogSmsSender).lastTo(PHONE);
      expect(sms?.template).toBe('abdm_link');

      const code = /\b(\d{6})\b/.exec(sms?.body ?? '')?.[1];
      expect(code).toBeTruthy();

      // Nothing yet.
      const [beforeRow] = await owner<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM abdm_care_context
         WHERE encounter_id = ${secondEncounterId}
      `;
      expect(beforeRow?.count).toBe(0);

      const confirmed = await gateway.ask('care-context.link.inbound-confirm', HIP_ID, {
        confirmation: { linkRefNumber: link.referenceNumber, token: code },
      });

      expect(confirmed.status).toBe(202);
      await gateway.waitForAnswer('on-confirm');

      const [row] = await owner<
        Array<{ initiated_by: string; linked_by_staff_id: string | null }>
      >`
        SELECT initiated_by, linked_by_staff_id FROM abdm_care_context
         WHERE encounter_id = ${secondEncounterId}
      `;

      // Attributed to the patient, and to no member of staff — the database
      // refuses the row that would claim otherwise.
      expect(row?.initiated_by).toBe('patient');
      expect(row?.linked_by_staff_id).toBeNull();
    }, 30_000);
  });

  describe('withdrawing', () => {
    it('unlinks a visit, and stops offering it to the network', async () => {
      const visits = (await get(`/patients/${patientId}/care-contexts`)).body as Array<{
        encounterId: string;
        careContextId: string | null;
        status: string | null;
      }>;

      const linked = visits.find((visit) => visit.status === 'linked');
      expect(linked?.careContextId).toBeTruthy();

      const response = await post(
        `/patients/${patientId}/care-contexts/${linked!.careContextId!}/unlink`,
        { reason: 'The patient asked us to stop sharing it' },
      );

      expect(response.status).toBe(201);

      const [row] = await owner<Array<{ status: string; unlinked_reason: string }>>`
        SELECT status, unlinked_reason FROM abdm_care_context
         WHERE id = ${linked!.careContextId!}
      `;

      expect(row?.status).toBe('unlinked');
      expect(row?.unlinked_reason).toMatch(/asked us to stop/);
    });

    it('cannot be linked again by rewriting the row', async () => {
      const [row] = await owner<Array<{ id: string }>>`
        SELECT id FROM abdm_care_context WHERE status = 'unlinked' LIMIT 1
      `;

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospital.id}, true)`;
          return tx`UPDATE abdm_care_context SET status = 'linked' WHERE id = ${row!.id}`;
        }),
      ).rejects.toThrow(/cannot move from unlinked to linked/);
    });
  });

  describe('what another hospital can see of it', () => {
    it('nothing at all', async () => {
      const rows = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${other.id}, true)`;
        return tx`SELECT id FROM abdm_care_context`;
      });

      expect(rows).toHaveLength(0);
    });

    it('and it cannot offer this hospital’s visits either', async () => {
      const response = await post(
        `/patients/${patientId}/care-contexts/link`,
        { encounterIds: [encounterId] },
        otherToken,
      );

      // The patient is not theirs, so there is nothing to find.
      expect([403, 404]).toContain(response.status);
    });
  });
});
