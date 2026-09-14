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

type Row = {
  resource_type: string;
  resource_id: string | null;
  patient_id: string | null;
  action: string;
  route: string | null;
  offline_viewed_at: string | Date | null;
  at: string | Date;
};

/**
 * Views made offline, uploaded when the connection returns (T24).
 *
 * The client may add to the audit trail, never shape it: a view must name a
 * read the offline cache could have held, of a patient or encounter the
 * hospital can see, at a time the cache could have served it.
 */
describe('offline view upload', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let clinician: SeededStaff;
  let frontDesk: SeededStaff;
  let clinicianToken: string;
  let frontDeskToken: string;

  let patientId: string;
  let encounterId: string;
  let patientElsewhere: string;
  let encounterElsewhere: string;

  const post = (path: string, token: string, body: unknown) =>
    ctx
      .http()
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  const offlineRows = (actorId: string) => owner<Row[]>`
    SELECT resource_type, resource_id, patient_id, action, route, offline_viewed_at, at
      FROM access_log
     WHERE actor_id = ${actorId} AND offline_viewed_at IS NOT NULL
  ORDER BY offline_viewed_at
  `;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Offline Test', mrnPrefix: 'SOT' });
    const b = await seedHospital({
      name: 'City General Offline Test',
      mrnPrefix: 'GOT',
      facilityType: 'allopathic',
    });

    clinician = a.staff.clinician as SeededStaff;
    frontDesk = a.staff.frontDesk as SeededStaff;
    clinicianToken = await signIn(ctx, clinician);
    frontDeskToken = await signIn(ctx, frontDesk);

    const registered = await post('/patients', frontDeskToken, {
      name: 'Kamala Offline',
      gender: 'female',
      dateOfBirth: '1970-01-20',
      phone: '9820077771',
    });
    patientId = registered.body.patient.id;
    encounterId = (await post('/encounters', clinicianToken, { patientId })).body.id;

    const tokenB = await signIn(ctx, b.staff.clinician as SeededStaff);
    const elsewhere = await post('/patients', await signIn(ctx, b.staff.frontDesk as SeededStaff), {
      name: 'Ramesh Elsewhere',
      gender: 'male',
      dateOfBirth: '1962-06-05',
      phone: '9820077772',
    });
    patientElsewhere = elsewhere.body.patient.id;
    encounterElsewhere = (await post('/encounters', tokenB, { patientId: patientElsewhere })).body
      .id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('records each view with the time the device showed it, beside the time it arrived', async () => {
    const views = [
      { path: '/encounters?date=2026-09-14&limit=100', viewedAt: minutesAgo(40) },
      { path: `/patients/${patientId}`, viewedAt: minutesAgo(30) },
      { path: `/patients/${patientId}/allergies`, viewedAt: minutesAgo(20) },
      { path: `/patients/${patientId}/summary`, viewedAt: minutesAgo(15) },
      { path: `/encounters/${encounterId}`, viewedAt: minutesAgo(10) },
    ];

    const response = await post('/audit/offline-views', clinicianToken, { views });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ recorded: 5, rejected: 0 });

    const rows = await offlineRows(clinician.id);
    expect(
      rows.map((row) => [
        row.resource_type,
        row.action,
        row.patient_id,
        row.resource_id,
        row.route,
      ]),
    ).toEqual([
      ['encounter', 'search', null, null, views[0]!.path],
      ['patient', 'read', patientId, patientId, views[1]!.path],
      ['allergy_intolerance', 'read', patientId, null, views[2]!.path],
      ['patient_summary', 'read', patientId, null, views[3]!.path],
      // The patient is worked out from the encounter, not taken from the client.
      ['encounter', 'read', patientId, encounterId, views[4]!.path],
    ]);

    rows.forEach((row, index) => {
      const viewedAt = new Date(row.offline_viewed_at!);
      expect(viewedAt.toISOString()).toBe(views[index]!.viewedAt);
      expect(new Date(row.at).getTime()).toBeGreaterThan(viewedAt.getTime());
    });
  });

  it('refuses what the offline cache could never have shown', async () => {
    const response = await post('/audit/offline-views', clinicianToken, {
      views: [
        // Not a cacheable read: the full timeline is never cached.
        { path: `/patients/${patientId}/timeline`, viewedAt: minutesAgo(5) },
        // Another hospital's patient and encounter.
        { path: `/patients/${patientElsewhere}/allergies`, viewedAt: minutesAgo(5) },
        { path: `/encounters/${encounterElsewhere}`, viewedAt: minutesAgo(5) },
        // In the future, and older than the cache keeps anything.
        { path: `/patients/${patientId}/vitals`, viewedAt: minutesAgo(-60) },
        { path: `/patients/${patientId}/vitals`, viewedAt: minutesAgo(60 * 24) },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ recorded: 0, rejected: 5 });
    expect(await offlineRows(clinician.id)).toHaveLength(5);
  });

  it('accepts clinical views only from roles that read clinical data', async () => {
    const response = await post('/audit/offline-views', frontDeskToken, {
      views: [
        { path: `/patients/${patientId}`, viewedAt: minutesAgo(3) },
        { path: `/patients/${patientId}/medications`, viewedAt: minutesAgo(3) },
      ],
    });

    expect(response.body).toEqual({ recorded: 1, rejected: 1 });
    expect((await offlineRows(frontDesk.id)).map((row) => row.resource_type)).toEqual(['patient']);
  });

  it('validates the upload itself', async () => {
    const empty = await post('/audit/offline-views', clinicianToken, { views: [] });
    expect(empty.status).toBe(400);

    const badTime = await post('/audit/offline-views', clinicianToken, {
      views: [{ path: `/patients/${patientId}`, viewedAt: 'yesterday' }],
    });
    expect(badTime.status).toBe(400);

    const tooMany = await post('/audit/offline-views', clinicianToken, {
      views: Array.from({ length: 501 }, () => ({
        path: `/patients/${patientId}`,
        viewedAt: minutesAgo(1),
      })),
    });
    expect(tooMany.status).toBe(400);
  });
});
