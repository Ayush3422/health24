import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
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
 * The emergency card (SP5 Phase 6, Decision L1): the patient chooses what it
 * shows; its link opens those facts, current, without signing in; every
 * opening is audited into the patient's access history; a lost card is
 * replaced and its old link stops working.
 */
describe('emergency card', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;

  let hospitalA: string;
  let lakshmiId: string;
  let otherId: string;
  let token: string;

  const LAKSHMI = { name: 'Lakshmi Card', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820066101' };
  const OTHER = { name: 'Other Card', gender: 'male', dateOfBirth: '1990-01-01', phone: '9820066102' };

  const post = (path: string, bearer: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (bearer ? request.set('Authorization', `Bearer ${bearer}`) : request).send(body);
  };

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  const patch = (path: string, bearer: string, body: Record<string, unknown>) =>
    ctx.http().patch(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  /** As a casualty department would: no sign-in at all. */
  const open = (link: string) => ctx.http().get(`/api/v1/emergency/${link}`);

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

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    const a = await seedHospital({ name: 'Sanjeevani Card Test', mrnPrefix: 'SCD' });
    hospitalA = a.hospital.id;
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

      const [bloodGroup] = await tx<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::blood_group))::text AS value LIMIT 1
      `;
      await tx`
        UPDATE patient SET blood_group = ${bloodGroup!.value}::blood_group,
               emergency_contact_name = 'Ravi Card', emergency_contact_phone = '+919820066199'
         WHERE id = ${lakshmiId}
      `;

      const [visit] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id, status, started_at, ended_at)
        VALUES (${lakshmiId}, ${hospitalA}, 'outpatient', 'ayurveda', ${clinician.id}, ${clinician.id}, 'finished',
                now() - interval '10 days', now() - interval '10 days' + interval '20 minutes')
        RETURNING id
      `;
      await tx`
        INSERT INTO allergy_intolerance (patient_id, hospital_id, encounter_id, substance, category, criticality, reaction, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${hospitalA}, ${visit!.id}, 'Penicillin', 'medication', 'high', 'Hives', ${clinician.id}, ${clinician.id})
      `;
      await tx`
        INSERT INTO medication_request (patient_id, hospital_id, encounter_id, system_of_medicine, medicine_name, strength, frequency, route, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${hospitalA}, ${visit!.id}, 'ayurveda', 'Avipattikar churna', '5 g', '1-0-1', 'oral', ${clinician.id}, ${clinician.id})
      `;
    });
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('shows the facts the patient chose, from its link, without signing in — and audits the opening', async () => {
    const bearer = await portalToken(LAKSHMI, lakshmiId);

    const before = await get('/portal/emergency-card', bearer);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.card).toBeNull();
    expect(before.body.facts).toMatchObject({
      name: 'Lakshmi Card',
      bloodGroup: expect.any(String),
      allergies: [{ substance: 'Penicillin', highRisk: true, reaction: 'Hives' }],
      medicines: [expect.objectContaining({ name: 'Avipattikar churna 5 g' })],
      emergencyContact: { name: 'Ravi Card', phone: '+919820066199' },
    });

    const created = await post('/portal/emergency-card', bearer, { fields: ['allergies', 'blood_group'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.fields).toEqual(['blood_group', 'allergies']);
    token = created.body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const page = await open(token);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.body.facts).toEqual({
      name: 'Lakshmi Card',
      ageYears: expect.any(Number),
      bloodGroup: before.body.facts.bloodGroup,
      allergies: [{ substance: 'Penicillin', highRisk: true, reaction: 'Hives' }],
    });

    const [audited] = await owner<Array<{ actor_type: string; ip_address: string | null }>>`
      SELECT actor_type::text, ip_address FROM access_log
       WHERE resource_type = 'emergency_card' AND actor_type = 'system' AND patient_id = ${lakshmiId}
    `;
    expect(audited?.actor_type).toBe('system');
    expect(audited?.ip_address).toBeTruthy();

    const history = await get('/portal/access-history', bearer);
    expect(
      history.body.entries.some(
        (entry: { actor: { kind: string }; resources: string[] }) =>
          entry.actor.kind === 'system' && entry.resources.includes('emergency_card'),
      ),
    ).toBe(true);
  });

  it('changes what the card shows without changing its link', async () => {
    const bearer = await portalToken(LAKSHMI, lakshmiId);

    const updated = await patch('/portal/emergency-card', bearer, {
      fields: ['blood_group', 'allergies', 'medicines', 'emergency_contact'],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.token).toBe(token);

    const page = await open(token);
    expect(page.body.facts).toMatchObject({
      medicines: [expect.objectContaining({ name: 'Avipattikar churna 5 g' })],
      emergencyContact: { name: 'Ravi Card', phone: '+919820066199' },
    });
    expect(page.body.facts).not.toHaveProperty('conditions');
  });

  it('replaces a lost card: the old link stops working at once', async () => {
    const bearer = await portalToken(LAKSHMI, lakshmiId);

    const replaced = await post('/portal/emergency-card/replace', bearer);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.token).not.toBe(token);
    expect(replaced.body.fields).toEqual(['blood_group', 'allergies', 'medicines', 'emergency_contact']);

    expect((await open(token)).status).toBe(404);
    expect((await open(replaced.body.token)).status).toBe(200);
    token = replaced.body.token;
  });

  it('keeps one card in use per patient, and only the patient’s own', async () => {
    const bearer = await portalToken(LAKSHMI, lakshmiId);
    expect((await post('/portal/emergency-card', bearer, { fields: ['blood_group'] })).status).toBe(409);
    expect((await post('/portal/emergency-card', bearer, { fields: [] })).status).toBe(400);
    expect((await post('/portal/emergency-card', bearer, { fields: ['favourite_food'] })).status).toBe(400);

    const other = await portalToken(OTHER, otherId);
    expect((await get('/portal/emergency-card', other)).body.card).toBeNull();
    expect((await post('/portal/emergency-card/revoke', other)).status).toBe(404);
    expect((await open(token)).status).toBe(200);
  });

  it('turns the card off', async () => {
    const bearer = await portalToken(LAKSHMI, lakshmiId);

    expect((await post('/portal/emergency-card/revoke', bearer)).status).toBe(204);
    expect((await open(token)).status).toBe(404);
    expect((await get('/portal/emergency-card', bearer)).body.card).toBeNull();
    expect((await post('/portal/emergency-card/revoke', bearer)).status).toBe(404);
  });

  it('gives nothing to a guessed link, and slows down whoever keeps guessing', async () => {
    expect((await open('not-a-token')).status).toBe(404);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      statuses.push((await open(randomBytes(32).toString('base64url'))).status);
    }

    expect(statuses.every((status) => status === 404 || status === 429)).toBe(true);
    expect(statuses).toContain(429);
  });

  it('in the database, keeps cards from hospitals, and a card’s link unchangeable', async () => {
    const { client: app, close } = appRoleDb();

    const as = (context: { hospital?: string; patient?: string }, text: string) =>
      app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${context.hospital ?? ''}, true)`;
        await tx`SELECT set_config('app.current_patient_id', ${context.patient ?? ''}, true)`;
        return tx.unsafe(text);
      });

    try {
      const atHospital = (await as({ hospital: hospitalA }, 'SELECT id FROM emergency_card')) as unknown as unknown[];
      expect(atHospital).toHaveLength(0);

      const own = (await as({ patient: lakshmiId }, 'SELECT id FROM emergency_card')) as unknown as unknown[];
      expect(own.length).toBeGreaterThan(0);

      await expect(
        as({ patient: lakshmiId }, `UPDATE emergency_card SET token_hash = 'x' WHERE revoked_at IS NULL`),
      ).rejects.toThrow(/permission denied/);
      await expect(as({ patient: lakshmiId }, 'DELETE FROM emergency_card')).rejects.toThrow(
        /permission denied/,
      );
      // A revoked card does not come back.
      await expect(
        as({ patient: lakshmiId }, `UPDATE emergency_card SET revoked_at = NULL, revoked_by_account_id = NULL`),
      ).rejects.toThrow(/revoked emergency card/);
    } finally {
      await close();
    }
  });
});
