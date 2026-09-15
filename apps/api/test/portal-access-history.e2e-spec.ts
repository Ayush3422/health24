import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Worker } from 'bullmq';
import { BreakGlassNotifier } from '../src/modules/notifications/break-glass-notifier';
import { createNotificationWorker } from '../src/modules/notifications/notification.worker';
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

type Entry = {
  id: string;
  actor: { kind: string; name?: string | null; role?: string | null };
  hospital: { id: string; name: string } | null;
  resources: string[];
  actions: string[];
  emergencyReason: string | null;
  consents: Array<{ captureMethod: string; grantedByYou: boolean; emergencyReason: string | null }>;
};

/**
 * The patient's access history and emergency-access notification (SP5 Phase 5,
 * DF6 and DF10): who read the record, where, and on what — and a text message,
 * sent once by the worker, when a hospital takes emergency access.
 */
describe('patient access history and emergency-access notification', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;
  let worker: Worker;

  let hospitalA: string;
  let hospitalB: string;
  let clinicianAToken: string;
  let clinicianBToken: string;
  let clinicianBId: string;
  const names: Record<string, string> = {};

  let lakshmiId: string;
  let noPhoneId: string;
  let emergencyId: string;

  const LAKSHMI = { name: 'Lakshmi History', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820077101' };
  const EMERGENCY_REASON = 'Unconscious on arrival; needs allergy history before treatment';

  const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (token ? request.set('Authorization', `Bearer ${token}`) : request).send(body);
  };

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  async function portalToken(): Promise<string> {
    await owner`DELETE FROM otp_challenge`;
    await post('/portal/auth/otp', null, { phone: LAKSHMI.phone });
    const code = sms.lastTo(`+91${LAKSHMI.phone}`)?.body.slice(0, 6);
    const verified = await post('/portal/auth/verify', null, { phone: LAKSHMI.phone, code });
    const session = await post('/portal/auth/session', null, {
      selectionToken: verified.body.selectionToken,
      patientId: lakshmiId,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    return session.body.accessToken as string;
  }

  async function eventually<T>(check: () => Promise<T | null | undefined>, ms = 15_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > until) throw new Error('Timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  beforeAll(async () => {
    // A queue of its own, so no other worker takes these jobs.
    process.env.NOTIFICATION_QUEUE_NAME = `patient-notifications-test-${randomUUID()}`;

    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    worker = createNotificationWorker({
      notifier: ctx.app.get(BreakGlassNotifier),
      redisUrl: process.env.REDIS_URL!,
      queueName: process.env.NOTIFICATION_QUEUE_NAME,
    });

    const a = await seedHospital({ name: 'Sanjeevani History Test', mrnPrefix: 'SHT' });
    const b = await seedHospital({ name: 'City General History Test', mrnPrefix: 'GHT', facilityType: 'allopathic' });
    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;

    const deskA = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    const deskB = await signIn(ctx, b.staff.frontDesk as SeededStaff);
    const clinicianA = a.staff.clinician as SeededStaff;
    const clinicianB = b.staff.clinician as SeededStaff;
    clinicianBId = clinicianB.id;
    clinicianAToken = await signIn(ctx, clinicianA);
    clinicianBToken = await signIn(ctx, clinicianB);

    lakshmiId = (await post('/patients', deskA, LAKSHMI)).body.patient.id;
    expect((await post('/patients', deskB, LAKSHMI)).body.linkedExisting).toBe(true);
    noPhoneId = (
      await post('/patients', deskB, { name: 'No Phone History', gender: 'male', dateOfBirth: '1980-01-01', phone: '9820077102' })
    ).body.patient.id;

    expect(
      (await post(`/patients/${lakshmiId}/portal-access`, deskA, { phone: LAKSHMI.phone, identityConfirmed: true })).status,
    ).toBe(201);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [visit] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id, status, started_at, ended_at)
        VALUES (${lakshmiId}, ${hospitalA}, 'outpatient', 'ayurveda', ${clinicianA.id}, ${clinicianA.id}, 'finished',
                now() - interval '40 days', now() - interval '40 days' + interval '20 minutes')
        RETURNING id
      `;
      await tx`
        INSERT INTO allergy_intolerance (patient_id, hospital_id, encounter_id, substance, category, criticality, reaction, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${hospitalA}, ${visit!.id}, 'Penicillin', 'medication', 'high', 'Hives', ${clinicianA.id}, ${clinicianA.id})
      `;

      for (const row of await tx<Array<{ id: string; name: string }>>`
        SELECT id::text, name FROM staff_user WHERE id IN (${clinicianA.id}, ${clinicianB.id})
      `) {
        names[row.id] = row.name;
      }
    });
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await closeOwner?.();
    await ctx?.close();
  });

  it('shows who read the record — name, role, hospital and what it rested on — and never the patient’s own reads', async () => {
    // Sanjeevani reads its own record.
    expect((await get(`/patients/${lakshmiId}/timeline`, clinicianAToken)).status).toBe(200);

    // The patient shares allergies with City General, whose clinician then reads.
    const token = await portalToken();
    expect(
      (await post('/portal/consents', token, { hospitalId: hospitalB, dataCategories: ['allergies'], validForDays: 30 }))
        .status,
    ).toBe(201);
    expect((await get(`/patients/${lakshmiId}/timeline`, clinicianBToken)).status).toBe(200);
    expect((await get('/portal/summary', token)).status).toBe(200);

    const response = await get('/portal/access-history', token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const entries = response.body.entries as Entry[];

    const atB = entries.find((entry) => entry.hospital?.id === hospitalB && entry.resources.includes('timeline'));
    expect(atB).toMatchObject({
      actor: { kind: 'staff', name: names[clinicianBId], role: 'clinician' },
      hospital: { name: 'City General History Test' },
      emergencyReason: null,
      consents: [expect.objectContaining({ captureMethod: 'patient_portal', grantedByYou: true })],
    });

    const atA = entries.find((entry) => entry.hospital?.id === hospitalA && entry.resources.includes('timeline'));
    expect(atA).toMatchObject({ actor: { kind: 'staff', role: 'clinician' }, consents: [] });

    // The desk that turned the portal on is there too; the patient's own reads are not.
    expect(
      entries.some((entry) => entry.actor.kind === 'staff' && entry.actor.role === 'front_desk'),
    ).toBe(true);
    expect(entries.some((entry) => entry.actor.kind === 'patient')).toBe(false);

    const [audited] = await owner<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM access_log WHERE resource_type = 'access_history' AND actor_type = 'patient'
    `;
    expect(audited!.count).toBe(1);
  });

  it('pages through the history without repeating an entry', async () => {
    const token = await portalToken();
    const seen: string[] = [];
    let before: string | null = null;

    do {
      const response = await get(
        `/portal/access-history?limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        token,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      seen.push(...(response.body.entries as Entry[]).map((entry) => entry.id));
      before = response.body.nextBefore;
    } while (before && seen.length < 50);

    const all = (await get('/portal/access-history', token)).body.entries as Entry[];
    expect(seen).toEqual(all.map((entry) => entry.id));
    expect((await get('/portal/access-history?before=yesterday', token)).status).toBe(400);
  });

  it('tells the patient of emergency access by text message, once, and shows it in the portal', async () => {
    const taken = await post(`/patients/${lakshmiId}/break-glass`, clinicianBToken, {
      reason: EMERGENCY_REASON,
      hours: 1,
    });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    emergencyId = taken.body.id;

    const notifiedAt = await eventually(async () => {
      const [row] = await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.system_context', 'on', true)`;
        return tx<Array<{ patient_notified_at: string | null }>>`
          SELECT patient_notified_at::text FROM consent_artefact WHERE id = ${emergencyId}
        `;
      });
      return row?.patient_notified_at;
    });
    expect(Date.parse(notifiedAt)).not.toBeNaN();

    const message = sms.lastTo(`+91${LAKSHMI.phone}`);
    expect(message).toMatchObject({ template: 'break_glass' });
    expect(message!.body).toContain('City General History Test');
    // Never the reason, nor anything clinical, in a text message.
    expect(message!.body).not.toContain('allergy');

    // Once: a second run finds nothing to tell.
    expect(await ctx.app.get(BreakGlassNotifier).notify(emergencyId)).toBe('skipped');

    const token = await portalToken();
    const notifications = await get('/portal/notifications', token);
    expect(notifications.status, JSON.stringify(notifications.body)).toBe(200);
    expect(notifications.body.emergencyAccesses).toEqual([
      expect.objectContaining({
        id: emergencyId,
        hospital: { id: hospitalB, name: 'City General History Test' },
        clinicianName: names[clinicianBId],
        reason: EMERGENCY_REASON,
        active: true,
        review: null,
        notifiedAt: expect.any(String),
      }),
    ]);

    const history = (await get('/portal/access-history', token)).body.entries as Entry[];
    expect(history.some((entry) => entry.emergencyReason === EMERGENCY_REASON)).toBe(true);
  });

  it('leaves emergency access for a patient with no portal phone to the sweep, and never refuses it', async () => {
    const taken = await post(`/patients/${noPhoneId}/break-glass`, clinicianBToken, {
      reason: 'Found collapsed; no relative present to give history',
      hours: 1,
    });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);

    const notifier = ctx.app.get(BreakGlassNotifier);
    expect(await notifier.notify(taken.body.id)).toBe('no_phone');
    expect(await notifier.pending()).toContain(taken.body.id);
  });

  it('lets only the system record that a patient was told', async () => {
    const { client: app, close } = appRoleDb();

    const asHospital = (sqlText: string, params: unknown[]) =>
      app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${hospitalB}, true)`;
        await tx.unsafe(sqlText, params as never[]);
      });

    const roleFor = async (context: { hospital?: string; patient?: string }) =>
      (await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${context.hospital ?? ''}, true)`;
        await tx`SELECT set_config('app.current_patient_id', ${context.patient ?? ''}, true)`;
        const [row] = await tx<Array<{ role: string | null }>>`SELECT app.staff_role_for_patient(${clinicianBId}::uuid) AS role`;
        return row!.role;
      })) as unknown as string | null;

    try {
      const [open] = await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.system_context', 'on', true)`;
        return tx<Array<{ id: string }>>`
          SELECT id::text FROM consent_artefact
           WHERE capture_method::text = 'break_glass' AND patient_notified_at IS NULL LIMIT 1
        `;
      });

      await expect(
        asHospital(`UPDATE consent_artefact SET patient_notified_at = now() WHERE id = $1`, [open!.id]),
      ).rejects.toThrow(/only the system/);

      expect(await roleFor({ patient: lakshmiId })).toBe('clinician');
      expect(await roleFor({ hospital: hospitalB, patient: lakshmiId })).toBeNull();
    } finally {
      await close();
    }
  });
});
