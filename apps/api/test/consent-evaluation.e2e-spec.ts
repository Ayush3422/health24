import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { appRoleDb, resetDatabase, seedHospital, testDb, type SeededStaff } from './harness';

/**
 * Consent evaluation, case by case (T25).
 *
 * `app.consent_permits(patient, category, date)` is the one function every
 * cross-hospital read in the database rests on. Each case runs as the
 * application role in a transaction that is rolled back, so the cases cannot
 * see each other's consents.
 */
describe('consent evaluation', () => {
  let app: postgres.Sql;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let hospitalA: string;
  let hospitalB: string;
  let hospitalC: string;
  let clinicianA: SeededStaff;
  let frontDeskB: SeededStaff;
  let clinicianB: SeededStaff;
  let patient: string;

  const ALL_CATEGORIES = [
    'encounters',
    'diagnoses',
    'medications',
    'allergies',
    'observations',
    'notes',
    'procedures',
  ];

  class Rollback {
    constructor(readonly value: unknown) {}
  }

  /** Runs as the application role, as a hospital, and always rolls back. */
  async function asHospital<T>(
    hospitalId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${hospitalId ?? ''}, true)`;
        throw new Rollback(await fn(tx));
      });
    } catch (caught) {
      if (caught instanceof Rollback) return caught.value as T;
      throw caught;
    }

    throw new Error('unreachable');
  }

  const switchTo = (tx: postgres.TransactionSql, hospitalId: string) =>
    tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;

  /** B's front desk records a consent inside the transaction. */
  async function consent(
    tx: postgres.TransactionSql,
    options: {
      categories?: string[];
      from?: string | null;
      to?: string | null;
      grantedAt?: string;
      expiresAt?: string;
      method?: 'signed_form' | 'break_glass';
    } = {},
  ): Promise<string> {
    const breakGlass = options.method === 'break_glass';
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO consent_artefact
        (patient_id, grantee_hospital_id, data_categories, date_range_from, date_range_to,
         granted_at, expires_at, capture_method, emergency_reason, recorded_by_staff_id)
      VALUES (
        ${patient}, ${hospitalB},
        ${`{${(options.categories ?? ['diagnoses']).join(',')}}`}::clinical_data_category[],
        ${options.from ?? null}, ${options.to ?? null},
        ${options.grantedAt ?? new Date().toISOString()},
        ${options.expiresAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString()},
        ${breakGlass ? 'break_glass' : 'signed_form'},
        ${breakGlass ? 'Unconscious on arrival; history needed' : null},
        ${breakGlass ? clinicianB.id : frontDeskB.id}
      )
      RETURNING id
    `;

    return row!.id;
  }

  async function permits(
    tx: postgres.TransactionSql,
    category: string,
    on: string,
  ): Promise<boolean> {
    const [row] = await tx<Array<{ permitted: boolean }>>`
      SELECT app.consent_permits(${patient}, ${category}::clinical_data_category, ${on}::date) AS permitted
    `;

    return row!.permitted;
  }

  beforeAll(async () => {
    await resetDatabase();

    const a = await seedHospital({ name: 'Sanjeevani Consent Test', mrnPrefix: 'SCE' });
    const b = await seedHospital({
      name: 'City General Consent Test',
      mrnPrefix: 'GCE',
      facilityType: 'allopathic',
    });
    const c = await seedHospital({
      name: 'Third Consent Test',
      mrnPrefix: 'TCE',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;
    hospitalC = c.hospital.id;
    clinicianA = a.staff.clinician as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    patient = (await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [created] = await tx<Array<{ id: string }>>`
        INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
        VALUES ('Kamala Consent', 'kamala consent', 'female', ${hospitalA})
        RETURNING id
      `;

      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn) VALUES
          (${created!.id}, ${hospitalA}, 'SCE-000001'),
          (${created!.id}, ${hospitalB}, 'GCE-000001'),
          (${created!.id}, ${hospitalC}, 'TCE-000001')
      `;

      return created!.id;
    })) as string;
  });

  afterAll(async () => {
    for (const close of closers) await close();
  });

  it('permits nothing without a consent', async () => {
    const result = await asHospital(hospitalB, async (tx) =>
      Promise.all(ALL_CATEGORIES.map((category) => permits(tx, category, '2026-03-15'))),
    );

    expect(result.every((permitted) => !permitted)).toBe(true);
  });

  it('permits nothing without a hospital context, whatever consents exist', async () => {
    const result = await asHospital(hospitalB, async (tx) => {
      await consent(tx, { categories: ALL_CATEGORIES });
      await tx`SELECT set_config('app.current_hospital_id', '', true)`;
      return permits(tx, 'diagnoses', '2026-03-15');
    });

    expect(result).toBe(false);
  });

  it('permits exactly the categories granted', async () => {
    const result = await asHospital(hospitalB, async (tx) => {
      await consent(tx, { categories: ['diagnoses', 'allergies'] });
      return Object.fromEntries(
        await Promise.all(
          ALL_CATEGORIES.map(async (category) => [
            category,
            await permits(tx, category, '2026-03-15'),
          ]),
        ),
      );
    });

    expect(result).toEqual({
      encounters: false,
      diagnoses: true,
      medications: false,
      allergies: true,
      observations: false,
      notes: false,
      procedures: false,
    });
  });

  it('includes both ends of a date range, and nothing either side', async () => {
    const result = await asHospital(hospitalB, async (tx) => {
      await consent(tx, { from: '2026-03-01', to: '2026-03-31' });
      return Promise.all(
        ['2026-02-28', '2026-03-01', '2026-03-31', '2026-04-01'].map((on) =>
          permits(tx, 'diagnoses', on),
        ),
      );
    });

    expect(result).toEqual([false, true, true, false]);
  });

  it('treats a missing end of the range as open', async () => {
    const result = await asHospital(hospitalB, async (tx) => {
      await consent(tx, { categories: ['notes'], from: '2026-03-01' });
      await consent(tx, { categories: ['procedures'], to: '2026-03-31' });

      return {
        fromOnly: [
          await permits(tx, 'notes', '2020-01-01'),
          await permits(tx, 'notes', '2030-01-01'),
        ],
        toOnly: [
          await permits(tx, 'procedures', '2020-01-01'),
          await permits(tx, 'procedures', '2030-01-01'),
        ],
      };
    });

    expect(result).toEqual({ fromOnly: [false, true], toOnly: [true, false] });
  });

  it('stops permitting once expired, and once revoked', async () => {
    const result = await asHospital(hospitalB, async (tx) => {
      await consent(tx, {
        categories: ['medications'],
        grantedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const revocable = await consent(tx, { categories: ['allergies'] });
      const beforeRevocation = await permits(tx, 'allergies', '2026-03-15');

      await tx`
        UPDATE consent_artefact
           SET status = 'revoked', revoked_at = now(), revoked_by_staff_id = ${frontDeskB.id},
               revocation_reason = 'Patient withdrew consent'
         WHERE id = ${revocable}
      `;

      return {
        expired: await permits(tx, 'medications', '2026-03-15'),
        beforeRevocation,
        afterRevocation: await permits(tx, 'allergies', '2026-03-15'),
      };
    });

    expect(result).toEqual({ expired: false, beforeRevocation: true, afterRevocation: false });
  });

  it('permits only the grantee, not every hospital the patient is linked to', async () => {
    const result = await asHospital(hospitalB, async (tx) => {
      await consent(tx, { categories: ALL_CATEGORIES });
      const asGrantee = await permits(tx, 'diagnoses', '2026-03-15');

      await switchTo(tx, hospitalC);
      const asAnotherLinkedHospital = await permits(tx, 'diagnoses', '2026-03-15');

      return { asGrantee, asAnotherLinkedHospital };
    });

    expect(result).toEqual({ asGrantee: true, asAnotherLinkedHospital: false });
  });

  it('lets emergency access permit every category, for as long as it lasts', async () => {
    const result = await asHospital(hospitalB, async (tx) => {
      await consent(tx, {
        method: 'break_glass',
        categories: ALL_CATEGORIES,
        expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      });

      return Promise.all(ALL_CATEGORIES.map((category) => permits(tx, category, '2016-06-01')));
    });

    expect(result.every(Boolean)).toBe(true);

    const lapsed = await asHospital(hospitalB, async (tx) => {
      await consent(tx, {
        method: 'break_glass',
        categories: ALL_CATEGORIES,
        grantedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      });

      return permits(tx, 'notes', '2026-03-15');
    });

    expect(lapsed).toBe(false);
  });

  it('reads a clinical time as its date in India Standard Time', async () => {
    const dates = await asHospital(
      hospitalB,
      async (tx) =>
        tx<Array<{ before: string; after: string }>>`
        SELECT app.ist_date('2026-03-31T18:29:59Z')::text AS before,
               app.ist_date('2026-03-31T18:30:00Z')::text AS after
      `,
    );

    expect(dates[0]).toEqual({ before: '2026-03-31', after: '2026-04-01' });
  });

  it('decides a row at the edge of a range by its Indian date, not its UTC one', async () => {
    const visible = await asHospital(hospitalA, async (tx) => {
      const [encounter] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id)
        VALUES (${patient}, ${hospitalA}, 'outpatient', 'ayurveda', ${clinicianA.id})
        RETURNING id
      `;

      // 11:30 pm on 31 March in India, and 12:30 am on 1 April in India —
      // both still 31 March in UTC.
      const rows = await tx<Array<{ id: string; recorded_at: string }>>`
        INSERT INTO condition (patient_id, hospital_id, encounter_id, recorded_by_staff_id, recorded_at)
        VALUES (${patient}, ${hospitalA}, ${encounter!.id}, ${clinicianA.id}, '2026-03-31T18:00:00Z'),
               (${patient}, ${hospitalA}, ${encounter!.id}, ${clinicianA.id}, '2026-03-31T19:00:00Z')
        RETURNING id, recorded_at::text
      `;

      await switchTo(tx, hospitalB);
      await consent(tx, { categories: ['diagnoses'], to: '2026-03-31' });

      const seen = await tx<Array<{ id: string }>>`SELECT id FROM condition`;
      const seenIds = new Set(seen.map((row) => row.id));

      return rows.map((row) => seenIds.has(row.id));
    });

    expect(visible).toEqual([true, false]);
  });
});
