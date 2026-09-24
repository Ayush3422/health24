import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
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

type Order = {
  id: string;
  status: string;
  priority: string;
  category: string;
  requestedDisplay: string;
  reference: string | null;
  collectedAt: string | null;
  inProgressAt: string | null;
  resultedAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  resultCount: number;
  entry: { source: string; enteredBy: { id: string; name: string | null } };
  orderedBy: { id: string; name: string | null };
};

/**
 * Orders (sp6-plan.md, Phase 1, Decision O1): what a hospital asked for,
 * how far the work has got, and the result that answers it.
 */
describe('orders', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let sanjeevani: string;
  let clinicianToken: string;
  let deskToken: string;
  let recordsToken: string;
  let clinician: SeededStaff;
  let desk: SeededStaff;
  let records: SeededStaff;

  let otherClinicianToken: string;
  let otherHospitalId: string;

  let patientId: string;
  let encounterId: string;

  const post = (path: string, bearer: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  const place = (body: Record<string, unknown> = {}) =>
    post('/orders', clinicianToken, {
      encounterId,
      category: 'laboratory',
      requestedDisplay: 'Liver function panel',
      ...body,
    });

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Orders Test', mrnPrefix: 'SOT' });
    const b = await seedHospital({
      name: 'City General Orders Test',
      mrnPrefix: 'CGO',
      facilityType: 'allopathic',
    });

    sanjeevani = a.hospital.id;
    otherHospitalId = b.hospital.id;
    clinician = a.staff.clinician as SeededStaff;
    desk = a.staff.frontDesk as SeededStaff;
    records = a.staff.records as SeededStaff;

    clinicianToken = await signIn(ctx, clinician);
    deskToken = await signIn(ctx, desk);
    recordsToken = await signIn(ctx, records);
    otherClinicianToken = await signIn(ctx, b.staff.clinician as SeededStaff);

    patientId = (
      await post('/patients', deskToken, {
        name: 'Ordered Patient',
        gender: 'female',
        dateOfBirth: '1975-02-20',
        phone: '9820066001',
      })
    ).body.patient.id;

    encounterId = (await post('/encounters', clinicianToken, { patientId })).body.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('places an order in the clinician’s name, and lists it on the encounter', async () => {
    const placed = await place({
      priority: 'urgent',
      requestedCodeSystem: 'http://loinc.org',
      requestedCode: '24325-3',
      clinicalNote: 'Burning after meals; check the liver before the next course',
    });

    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const order = placed.body as Order;

    expect(order).toMatchObject({
      status: 'ordered',
      priority: 'urgent',
      category: 'laboratory',
      requestedDisplay: 'Liver function panel',
      resultCount: 0,
      collectedAt: null,
      resultedAt: null,
      entry: { source: 'direct' },
    });
    expect(order.orderedBy.id).toBe(clinician.id);

    const onEncounter = await get(`/encounters/${encounterId}/orders`, clinicianToken);
    expect(onEncounter.body).toEqual([expect.objectContaining({ id: order.id })]);
  });

  it('refuses an order with a code but no system, and one for another hospital’s encounter', async () => {
    const codeless = await place({ requestedCode: '24325-3' });
    expect(codeless.status, JSON.stringify(codeless.body)).toBe(400);

    const elsewhere = await post('/orders', otherClinicianToken, {
      encounterId,
      category: 'laboratory',
      requestedDisplay: 'Liver function panel',
    });
    // Another hospital cannot even see the encounter, let alone order against it.
    expect([403, 404]).toContain(elsewhere.status);
  });

  it('is transcribed by records staff only in a named clinician’s name', async () => {
    const unnamed = await post('/orders', recordsToken, {
      encounterId,
      category: 'imaging',
      requestedDisplay: 'Ultrasound abdomen',
    });
    expect(unnamed.status, JSON.stringify(unnamed.body)).toBe(400);

    const transcribed = await post('/orders', recordsToken, {
      encounterId,
      category: 'imaging',
      requestedDisplay: 'Ultrasound abdomen',
      onBehalfOfClinicianId: clinician.id,
    });
    expect(transcribed.status, JSON.stringify(transcribed.body)).toBe(201);
    expect(transcribed.body).toMatchObject({
      entry: { source: 'transcribed', enteredBy: { id: records.id } },
      orderedBy: { id: clinician.id },
    });
  });

  it('moves forward as the work is done, and never backwards', async () => {
    const { body: order } = await place();

    const collected = await post(`/orders/${order.id}/advance`, deskToken, {
      status: 'collected',
      reference: 'SOT-24601',
    });
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect(collected.body).toMatchObject({ status: 'collected', reference: 'SOT-24601' });
    expect(collected.body.collectedAt).toBeTruthy();

    const started = await post(`/orders/${order.id}/advance`, deskToken, { status: 'in_progress' });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: 'in_progress', reference: 'SOT-24601' });

    // Backwards is refused by the application…
    const again = await post(`/orders/${order.id}/advance`, deskToken, { status: 'collected' });
    expect(again.status, JSON.stringify(again.body)).toBe(409);

    // …and by the database, whatever the application believes.
    const { client: app, close } = appRoleDb();
    try {
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${sanjeevani}, true)`;
          await tx`UPDATE service_request SET status = 'ordered' WHERE id = ${order.id}`;
        }),
      ).rejects.toThrow(/cannot move from in_progress to ordered/);
    } finally {
      await close();
    }
  });

  it('closes when its results are typed, and counts them', async () => {
    const { body: order } = await place();
    await post(`/orders/${order.id}/advance`, deskToken, { status: 'in_progress' });

    const recorded = await post('/results', clinicianToken, {
      patientId,
      encounterId,
      serviceRequestId: order.id,
      panel: 'lft',
      collectedAt: new Date(Date.now() - 3_600_000).toISOString(),
      results: [
        { code: '1742-6', value: 62, unit: 'U/L', referenceLow: 7, referenceHigh: 56 },
        { code: '1920-8', value: 31, unit: 'U/L', referenceLow: 5, referenceHigh: 40 },
      ],
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);

    const [after] = (await get(`/encounters/${encounterId}/orders`, clinicianToken)).body.filter(
      (candidate: Order) => candidate.id === order.id,
    );

    expect(after).toMatchObject({ status: 'resulted', resultCount: 2 });
    expect(after.resultedAt).toBeTruthy();
  });

  it('refuses a result against a cancelled order, and a cancellation after the result', async () => {
    const { body: cancelled } = await place();
    const stopped = await post(`/orders/${cancelled.id}/cancel`, clinicianToken, {
      reason: 'Ordered twice by mistake',
    });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body).toMatchObject({
      status: 'cancelled',
      cancelledReason: 'Ordered twice by mistake',
    });

    const late = await post('/results', clinicianToken, {
      patientId,
      serviceRequestId: cancelled.id,
      panel: 'lft',
      collectedAt: new Date().toISOString(),
      results: [{ code: '1742-6', value: 40, unit: 'U/L' }],
    });
    expect(late.status, JSON.stringify(late.body)).toBe(409);

    const { body: resulted } = await place();
    await post('/results', clinicianToken, {
      patientId,
      serviceRequestId: resulted.id,
      panel: 'lft',
      collectedAt: new Date().toISOString(),
      results: [{ code: '1742-6', value: 38, unit: 'U/L' }],
    });

    const tooLate = await post(`/orders/${resulted.id}/cancel`, clinicianToken, {
      reason: 'Changed my mind after the result came back',
    });
    expect(tooLate.status, JSON.stringify(tooLate.body)).toBe(409);
  });

  it('shows the lab what is outstanding, urgent first, and leaves finished work out', async () => {
    const worklist = await get('/orders?category=laboratory', deskToken);
    expect(worklist.status, JSON.stringify(worklist.body)).toBe(200);

    const entries = worklist.body.entries as Array<
      Order & { patient: { name: string; mrn: string | null }; waitingHours: number }
    >;

    expect(entries.length).toBeGreaterThan(0);
    expect(
      entries.every((entry) => ['ordered', 'collected', 'in_progress'].includes(entry.status)),
    ).toBe(true);
    expect(entries[0]).toMatchObject({ priority: 'urgent', patient: { name: 'Ordered Patient' } });
    expect(entries[0]!.patient.mrn).toMatch(/^SOT/);
    expect(entries[0]!.waitingHours).toBeGreaterThanOrEqual(0);

    // Imaging is another desk's list.
    const imaging = await get('/orders?category=imaging', deskToken);
    expect((imaging.body.entries as Order[]).every((entry) => entry.category === 'imaging')).toBe(
      true,
    );
  });

  it('is the ordering hospital’s alone: no consent makes an order readable elsewhere', async () => {
    // City General registers the same patient and takes emergency access,
    // which reaches every clinical category there is.
    const registered = await post('/patients', otherClinicianToken, {
      name: 'Ordered Patient',
      gender: 'female',
      dateOfBirth: '1975-02-20',
      phone: '9820066001',
    });
    expect(registered.body.linkedExisting).toBe(true);

    const broken = await post(`/patients/${patientId}/break-glass`, otherClinicianToken, {
      reason: 'Unconscious in casualty; needs the whole history now',
      hours: 1,
    });
    expect(broken.status, JSON.stringify(broken.body)).toBe(201);

    const theirs = await get(`/patients/${patientId}/orders`, otherClinicianToken);
    expect(theirs.status).toBe(200);
    expect(theirs.body.orders).toEqual([]);

    // And in the database itself, not merely in what the service returns.
    const { client: app, close } = appRoleDb();
    try {
      const visible = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${otherHospitalId}, true)`;
        return tx`SELECT count(*)::int AS count FROM service_request`;
      });
      expect(visible[0]!.count).toBe(0);
    } finally {
      await close();
    }

    const mine = await get(`/patients/${patientId}/orders`, clinicianToken);
    expect(mine.body.orders.length).toBeGreaterThan(0);
    expect(mine.body.sharedFromOtherHospitals).toBe(false);
  });

  it('is never deleted, and records who asked for it', async () => {
    const { body: order } = await place();

    const { client: app, close } = appRoleDb();
    try {
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${sanjeevani}, true)`;
          await tx`DELETE FROM service_request WHERE id = ${order.id}`;
        }),
        // The application role holds no DELETE on the table at all, so the
        // refusal comes from the grant before the trigger is even reached.
      ).rejects.toThrow(/permission denied|never deleted/);
    } finally {
      await close();
    }

    const [audited] = await owner<Array<{ action: string; actor_id: string }>>`
      SELECT action::text, actor_id FROM access_log
       WHERE resource_type = 'service_request' AND resource_id = ${order.id} AND action = 'create'
    `;
    expect(audited?.actor_id).toBe(clinician.id);
  });
});
