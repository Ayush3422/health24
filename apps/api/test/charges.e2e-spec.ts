import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatPaise, paiseFromRupees } from '@health24/shared';
import {
  appRoleDb,
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

type Item = {
  id: string;
  code: string;
  name: string;
  pricePaise: number;
  activeFrom: string;
  activeTo: string | null;
  inForce: boolean;
};

type Charge = {
  id: string;
  code: string;
  quantity: number;
  unitPricePaise: number;
  amountPaise: number;
  source: string;
  sourceId: string | null;
  status: string;
  voidedReason: string | null;
};

type EncounterCharges = {
  charges: Charge[];
  totalPaise: number;
  invoicedPaise: number;
  uncharged: Array<{ source: string; sourceId: string; description: string; quantity: number }>;
};

const yesterday = (): string => {
  const date = new Date(Date.now() - 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
};

const tomorrow = (): string => {
  const date = new Date(Date.now() + 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
};

/**
 * The catalogue and its charges (sp6-plan.md, Phase 6, Decision R1): what a
 * hospital charges for, what it costs, and what a patient is billed — in whole
 * paise, with the arithmetic done by the database.
 */
describe('the catalogue and charges', () => {
  let ctx: TestContext;

  let hospitalId: string;
  let otherHospitalId: string;
  let adminToken: string;
  let deskToken: string;
  let clinicianToken: string;
  let recordsToken: string;
  let otherAdminToken: string;

  let patientId: string;
  let encounterId: string;
  let consultation: Item;
  let bedItem: Item;
  let labItem: Item;

  const post = (path: string, bearer: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Billing Test', mrnPrefix: 'SBT' });
    const b = await seedHospital({
      name: 'City General Billing Test',
      mrnPrefix: 'CGB',
      facilityType: 'allopathic',
    });

    hospitalId = a.hospital.id;
    otherHospitalId = b.hospital.id;

    adminToken = await signIn(ctx, a.staff.admin as SeededStaff);
    deskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    clinicianToken = await signIn(ctx, a.staff.clinician as SeededStaff);
    recordsToken = await signIn(ctx, a.staff.records as SeededStaff);
    otherAdminToken = await signIn(ctx, b.staff.admin as SeededStaff);

    patientId = (
      await post('/patients', deskToken, {
        name: 'Billed Patient',
        gender: 'male',
        dateOfBirth: '1984-05-21',
        phone: '9820100001',
      })
    ).body.patient.id;

    encounterId = (await post('/encounters', clinicianToken, { patientId, class: 'inpatient' }))
      .body.id;
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('reads and writes money as whole paise, never as rupees', () => {
    expect(paiseFromRupees('1,250.50')).toBe(125050);
    expect(paiseFromRupees('₹800')).toBe(80000);
    expect(paiseFromRupees('0.05')).toBe(5);
    expect(paiseFromRupees('12.345')).toBeNull();

    expect(formatPaise(125050)).toBe('₹1,250.50');
    expect(formatPaise(5)).toBe('₹0.05');
    expect(formatPaise(0)).toBe('₹0.00');
  });

  it('is set up by the hospital administrator, with a price and a day it starts', async () => {
    const added = await post('/catalogue', adminToken, {
      code: 'OPD-GEN',
      name: 'General consultation',
      category: 'consultation',
      unit: 'visit',
      pricePaise: 30000,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    consultation = added.body as Item;
    expect(consultation).toMatchObject({ pricePaise: 30000, activeTo: null, inForce: true });

    bedItem = (
      await post('/catalogue', adminToken, {
        code: 'BED-GEN',
        name: 'General ward bed',
        category: 'bed',
        unit: 'day',
        pricePaise: 120000,
      })
    ).body;

    labItem = (
      await post('/catalogue', adminToken, {
        code: 'LAB-LFT',
        name: 'Liver function panel',
        category: 'laboratory',
        unit: 'test',
        pricePaise: 45000,
      })
    ).body;

    // One code, one price in force.
    const duplicate = await post('/catalogue', adminToken, {
      code: 'OPD-GEN',
      name: 'General consultation',
      category: 'consultation',
      pricePaise: 35000,
    });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(400);

    // And the desk does not set prices.
    expect(
      (
        await post('/catalogue', deskToken, {
          code: 'X',
          name: 'Something',
          category: 'other',
          pricePaise: 100,
        })
      ).status,
    ).toBe(403);
  });

  it('is charged at the price in force, copied onto the charge', async () => {
    const captured = await post('/charges', deskToken, {
      encounterId,
      itemId: consultation.id,
      quantity: 1,
    });

    expect(captured.status, JSON.stringify(captured.body)).toBe(201);
    expect(captured.body).toMatchObject({
      code: 'OPD-GEN',
      unitPricePaise: 30000,
      amountPaise: 30000,
      status: 'captured',
      source: 'manual',
    });
  });

  it('keeps yesterday’s price on yesterday’s charge when the price changes', async () => {
    const repriced = await post(`/catalogue/${consultation.id}/reprice`, adminToken, {
      pricePaise: 40000,
      activeFrom: tomorrow(),
    });
    expect(repriced.status, JSON.stringify(repriced.body)).toBe(201);
    expect(repriced.body).toMatchObject({ pricePaise: 40000, inForce: false });

    // The old row is closed, not overwritten.
    const history = await get('/catalogue?history=true&q=OPD-GEN', adminToken);
    const rows = history.body.items as Item[];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.pricePaise === 30000)!.activeTo).toBeTruthy();

    // What was charged before the change is unchanged.
    const charges = (await get(`/encounters/${encounterId}/charges`, deskToken))
      .body as EncounterCharges;
    expect(charges.charges[0]).toMatchObject({ unitPricePaise: 30000, amountPaise: 30000 });

    // Today's charge still uses today's price, because the new one starts tomorrow.
    const today = await post('/charges', deskToken, {
      encounterId,
      itemId: consultation.id,
      quantity: 1,
    });
    expect(today.body).toMatchObject({ unitPricePaise: 30000 });
  });

  it('a price cannot start before the one it replaces, and a closed row is not repriced', async () => {
    const backwards = await post(`/catalogue/${labItem.id}/reprice`, adminToken, {
      pricePaise: 50000,
      activeFrom: yesterday(),
    });
    expect(backwards.status, JSON.stringify(backwards.body)).toBe(400);

    const retired = await post(`/catalogue/${labItem.id}/retire`, adminToken, {});
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.activeTo).toBeTruthy();

    expect(
      (await post(`/catalogue/${labItem.id}/reprice`, adminToken, { pricePaise: 50000 })).status,
    ).toBe(409);
  });

  it('shows what the record says is chargeable and has not been charged', async () => {
    const ward = (
      await post('/wards', adminToken, { name: 'Billing ward', kind: 'general', beds: ['B1'] })
    ).body;
    await post('/admissions', deskToken, { encounterId, bedId: ward.beds[0].id });

    await post('/procedures', clinicianToken, { encounterId, name: 'Dressing' });

    const charges = (await get(`/encounters/${encounterId}/charges`, deskToken))
      .body as EncounterCharges;

    const stay = charges.uncharged.find((row) => row.source === 'bed_day');
    const procedure = charges.uncharged.find((row) => row.source === 'procedure');

    expect(stay).toMatchObject({ description: 'Billing ward · B1', quantity: 1 });
    expect(procedure).toMatchObject({ description: 'Dressing' });

    // Charging the stay takes it off the list, and is refused a second time.
    const bedDays = await post('/charges', deskToken, {
      encounterId,
      itemId: bedItem.id,
      quantity: stay!.quantity,
      source: 'bed_day',
      sourceId: stay!.sourceId,
    });
    expect(bedDays.status, JSON.stringify(bedDays.body)).toBe(201);
    expect(bedDays.body).toMatchObject({ amountPaise: 120000 * stay!.quantity });

    const again = await post('/charges', deskToken, {
      encounterId,
      itemId: bedItem.id,
      quantity: 1,
      source: 'bed_day',
      sourceId: stay!.sourceId,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(409);

    const after = (await get(`/encounters/${encounterId}/charges`, deskToken))
      .body as EncounterCharges;
    expect(after.uncharged.some((row) => row.source === 'bed_day')).toBe(false);
  });

  it('adds up to the paisa, and a voided charge counts for nothing', async () => {
    const before = (await get(`/encounters/${encounterId}/charges`, deskToken))
      .body as EncounterCharges;

    const live = before.charges.filter((charge) => charge.status !== 'voided');
    expect(before.totalPaise).toBe(live.reduce((total, charge) => total + charge.amountPaise, 0));

    const [first] = live;
    const voided = await post(`/charges/${first!.id}/void`, deskToken, {
      reason: 'Charged to the wrong encounter',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body).toMatchObject({
      status: 'voided',
      voidedReason: 'Charged to the wrong encounter',
    });

    const after = (await get(`/encounters/${encounterId}/charges`, deskToken))
      .body as EncounterCharges;
    expect(after.totalPaise).toBe(before.totalPaise - first!.amountPaise);

    // Voiding twice says so rather than pretending.
    expect((await post(`/charges/${first!.id}/void`, deskToken, { reason: 'Again' })).status).toBe(
      409,
    );
  });

  it('is the hospital’s own: no catalogue, no charge, crosses to another', async () => {
    const theirs = await get('/catalogue', otherAdminToken);
    expect(theirs.status).toBe(200);
    expect(theirs.body.items).toEqual([]);

    const { client: app, close } = appRoleDb();
    try {
      const counts = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${otherHospitalId}, true)`;
        return tx`
          SELECT (SELECT count(*)::int FROM service_catalogue_item) AS items,
                 (SELECT count(*)::int FROM charge) AS charges
        `;
      });

      expect(counts[0]).toMatchObject({ items: 0, charges: 0 });
    } finally {
      await close();
    }
  });

  it('in the database, refuses arithmetic that does not add up, an edit or a deletion', async () => {
    const charges = (await get(`/encounters/${encounterId}/charges`, deskToken))
      .body as EncounterCharges;
    const live = charges.charges.find((charge) => charge.status === 'captured')!;

    const { client: app, close } = appRoleDb();

    try {
      // Two of something at ₹300 is ₹600, and nothing else.
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`
            INSERT INTO charge (patient_id, hospital_id, encounter_id, item_id, quantity,
                                unit_price_paise, amount_paise, captured_by_staff_id)
            SELECT patient_id, hospital_id, encounter_id, item_id, 2, 30000, 30000,
                   captured_by_staff_id
              FROM charge WHERE id = ${live.id}
          `;
        }),
      ).rejects.toThrow(/charge_amount_is_the_arithmetic/);

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE charge SET amount_paise = 1 WHERE id = ${live.id}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/);

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`DELETE FROM charge WHERE id = ${live.id}`;
        }),
      ).rejects.toThrow(/permission denied|never deleted/);
    } finally {
      await close();
    }
  });

  it('is not the records clerk’s job, and not read by a clinician either', async () => {
    expect((await get(`/encounters/${encounterId}/charges`, recordsToken)).status).toBe(403);
    expect((await get(`/encounters/${encounterId}/charges`, clinicianToken)).status).toBe(403);
  });
});
