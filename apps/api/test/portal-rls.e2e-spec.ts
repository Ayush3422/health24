import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { appRoleDb, resetDatabase, seedHospital, testDb, type SeededStaff } from './harness';

/**
 * The patient context in the database (SP5 Phase 1): a patient reads their
 * own record at every hospital without consent, and nothing else; writes
 * nothing clinical; and portal accounts, codes and sessions stay out of every
 * context but sign-in's.
 *
 * Every case runs as the application role; cases that write are rolled back.
 */
describe('patient context: own record, and portal identity', () => {
  let app: postgres.Sql;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let hospitalA: string;
  let hospitalB: string;
  let hospitalC: string;
  let frontDeskA: SeededStaff;
  let adminA: SeededStaff;
  let clinicianA: SeededStaff;
  let clinicianB: SeededStaff;

  /** Linked to A and B, with records at both. */
  let lakshmi: string;
  /** Another patient at A. */
  let meena: string;

  let lakshmiAtA: string;
  let lakshmiAtB: string;
  let meenaAtA: string;
  let lakshmiReport: string;
  let accessA: string;

  class Rollback {
    constructor(readonly value: unknown) {}
  }

  async function as<T>(
    context: { hospital?: string; patient?: string },
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${context.hospital ?? ''}, true)`;
        await tx`SELECT set_config('app.current_patient_id', ${context.patient ?? ''}, true)`;
        throw new Rollback(await fn(tx));
      });
    } catch (caught) {
      if (caught instanceof Rollback) return caught.value as T;
      throw caught;
    }

    throw new Error('unreachable');
  }

  const ids = async (tx: postgres.TransactionSql, table: string, column = 'id') =>
    (await tx.unsafe<Array<{ id: string }>>(`SELECT ${column}::text AS id FROM "${table}"`))
      .map((row) => row.id)
      .sort();

  beforeAll(async () => {
    await resetDatabase();

    const a = await seedHospital({ name: 'Sanjeevani Portal RLS', mrnPrefix: 'SPR' });
    const b = await seedHospital({ name: 'City General Portal RLS', mrnPrefix: 'GPR', facilityType: 'allopathic' });
    const c = await seedHospital({ name: 'Unrelated Portal RLS', mrnPrefix: 'UPR', facilityType: 'allopathic' });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;
    hospitalC = c.hospital.id;
    frontDeskA = a.staff.frontDesk as SeededStaff;
    adminA = a.staff.admin as SeededStaff;
    clinicianA = a.staff.clinician as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const created = await tx<Array<{ id: string }>>`
        INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
        VALUES ('Lakshmi Portal', 'lakshmi portal', 'female', ${hospitalA}),
               ('Meena Portal', 'meena portal', 'female', ${hospitalA})
        RETURNING id
      `;
      [lakshmi, meena] = created.map((row) => row.id) as [string, string];

      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn) VALUES
          (${lakshmi}, ${hospitalA}, 'SPR-000001'),
          (${lakshmi}, ${hospitalB}, 'GPR-000001'),
          (${meena}, ${hospitalA}, 'SPR-000002')
      `;

      const encounter = async (patient: string, hospital: string, clinician: string) => {
        const [row] = await tx<Array<{ id: string }>>`
          INSERT INTO encounter
            (patient_id, hospital_id, class, system_of_medicine, attending_staff_id,
             recorded_by_staff_id, status, started_at)
          VALUES (${patient}, ${hospital}, 'outpatient', 'allopathy', ${clinician}, ${clinician},
                  'in_progress', now() - interval '3 days')
          RETURNING id
        `;
        return row!.id;
      };

      lakshmiAtA = await encounter(lakshmi, hospitalA, clinicianA.id);
      lakshmiAtB = await encounter(lakshmi, hospitalB, clinicianB.id);
      meenaAtA = await encounter(meena, hospitalA, clinicianA.id);

      const [report] = await tx<Array<{ id: string }>>`
        INSERT INTO document_reference (patient_id, hospital_id, doc_type, report_date, recorded_by_staff_id)
        VALUES (${lakshmi}, ${hospitalB}, 'lab_report', '2026-09-01', ${clinicianB.id})
        RETURNING id
      `;
      lakshmiReport = report!.id;

      await tx`
        INSERT INTO access_log (actor_type, hospital_id, patient_id, resource_type, action)
        VALUES ('staff', ${hospitalB}, ${lakshmi}, 'timeline', 'read'),
               ('staff', ${hospitalA}, ${meena}, 'timeline', 'read')
      `;
    });

    accessA = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_hospital_id', ${hospitalA}, true)`;
      const [account] = await tx<Array<{ id: string }>>`SELECT app.portal_account_for_phone('+919820055001') AS id`;
      const [access] = await tx<Array<{ id: string }>>`
        INSERT INTO patient_portal_access
          (account_id, patient_id, phone, activated_at_hospital_id, activated_by_staff_id)
        VALUES (${account!.id}, ${lakshmi}, '+919820055001', ${hospitalA}, ${frontDeskA.id})
        RETURNING id
      `;
      return access!.id;
    }) as unknown as string;
  });

  afterAll(async () => {
    for (const close of closers) await close();
  });

  it('shows a patient their own record at every hospital, without consent, and no one else’s', async () => {
    const seen = await as({ patient: lakshmi }, async (tx) => ({
      encounters: await ids(tx, 'encounter'),
      documents: await ids(tx, 'document_reference'),
      patients: await ids(tx, 'patient'),
      links: (await ids(tx, 'patient_hospital_link', 'hospital_id')).length,
      audit: (await ids(tx, 'access_log')).length,
    }));

    expect(seen).toEqual({
      encounters: [lakshmiAtA, lakshmiAtB].sort(),
      documents: [lakshmiReport],
      patients: [lakshmi],
      links: 2,
      audit: 1,
    });

    const other = await as({ patient: meena }, (tx) => ids(tx, 'encounter'));
    expect(other).toEqual([meenaAtA]);
  });

  it('never mixes the patient branch with a hospital’s context', async () => {
    // With a hospital set, only that hospital's rules apply.
    const seen = await as({ hospital: hospitalC, patient: lakshmi }, (tx) => ids(tx, 'encounter'));
    expect(seen).toEqual([]);
  });

  it('lets a patient write nothing clinical', async () => {
    await expect(
      as({ patient: lakshmi }, (tx) =>
        tx`
          INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id)
          VALUES (${lakshmi}, ${hospitalA}, 'outpatient', 'allopathy', ${clinicianA.id}, ${clinicianA.id})
        `,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps accounts, codes and sessions out of every context but sign-in', async () => {
    for (const context of [{ hospital: hospitalA }, { patient: lakshmi }]) {
      const seen = await as(context, async (tx) => ({
        accounts: await ids(tx, 'patient_account'),
        codes: await ids(tx, 'otp_challenge'),
        sessions: await ids(tx, 'patient_session'),
      }));
      expect(seen).toEqual({ accounts: [], codes: [], sessions: [] });
    }
  });

  it('creates an account for a phone only from a hospital desk, and finds the same one again', async () => {
    await expect(
      as({ patient: lakshmi }, (tx) => tx`SELECT app.portal_account_for_phone('+919820055002')`),
    ).rejects.toThrow(/created by a hospital desk/);

    await expect(
      as({ hospital: hospitalA }, (tx) => tx`SELECT app.portal_account_for_phone('9820055002')`),
    ).rejects.toThrow(/E\.164/);

    const [first, second, systemAfter] = await as({ hospital: hospitalA }, async (tx) => {
      const [one] = await tx<Array<{ id: string }>>`SELECT app.portal_account_for_phone('+919820055001') AS id`;
      const [two] = await tx<Array<{ id: string }>>`SELECT app.portal_account_for_phone('+919820055001') AS id`;
      const [system] = await tx<Array<{ on: string }>>`SELECT app.is_system()::text AS on`;
      return [one!.id, two!.id, system!.on];
    });

    expect(first).toBe(second);
    // The function's system context does not outlive it.
    expect(systemAfter).toBe('false');
  });

  it('shows a portal access to every hospital holding the patient, and to the patient', async () => {
    expect(await as({ hospital: hospitalA }, (tx) => ids(tx, 'patient_portal_access'))).toEqual([accessA]);
    expect(await as({ hospital: hospitalB }, (tx) => ids(tx, 'patient_portal_access'))).toEqual([accessA]);
    expect(await as({ hospital: hospitalC }, (tx) => ids(tx, 'patient_portal_access'))).toEqual([]);
    expect(await as({ patient: lakshmi }, (tx) => ids(tx, 'patient_portal_access'))).toEqual([accessA]);
    expect(await as({ patient: meena }, (tx) => ids(tx, 'patient_portal_access'))).toEqual([]);
  });

  it('activates only at a hospital holding the patient, by desk, records or clinical staff', async () => {
    await expect(
      as({ hospital: hospitalC }, async (tx) => {
        const [account] = await tx<Array<{ id: string }>>`SELECT app.portal_account_for_phone('+919820055003') AS id`;
        return tx`
          INSERT INTO patient_portal_access (account_id, patient_id, phone, activated_at_hospital_id, activated_by_staff_id)
          VALUES (${account!.id}, ${lakshmi}, '+919820055003', ${hospitalC}, ${frontDeskA.id})
        `;
      }),
    ).rejects.toThrow(/row-level security|foreign key/);

    await expect(
      as({ hospital: hospitalA }, async (tx) => {
        const [account] = await tx<Array<{ id: string }>>`SELECT app.portal_account_for_phone('+919820055003') AS id`;
        return tx`
          INSERT INTO patient_portal_access (account_id, patient_id, phone, activated_at_hospital_id, activated_by_staff_id)
          VALUES (${account!.id}, ${meena}, '+919820055003', ${hospitalA}, ${adminA.id})
        `;
      }),
    ).rejects.toThrow(/recorded by the front desk, records staff or a clinician/);

    await expect(
      as({ hospital: hospitalA }, async (tx) => {
        const [account] = await tx<Array<{ id: string }>>`SELECT app.portal_account_for_phone('+919820055003') AS id`;
        return tx`
          INSERT INTO patient_portal_access (account_id, patient_id, phone, activated_at_hospital_id, activated_by_staff_id)
          VALUES (${account!.id}, ${meena}, '+919820055999', ${hospitalA}, ${frontDeskA.id})
        `;
      }),
    ).rejects.toThrow(/must be its account/);
  });

  it('revokes once, and never deletes', async () => {
    await expect(
      as({ hospital: hospitalB }, async (tx) => {
        await tx`
          UPDATE patient_portal_access
             SET revoked_at = now(), revoked_by_staff_id = ${clinicianB.id}, revoked_reason = 'Lost phone'
           WHERE id = ${accessA}
        `;
        await tx`UPDATE patient_portal_access SET revoked_reason = 'Changed' WHERE id = ${accessA}`;
      }),
    ).rejects.toThrow(/is set once/);

    await expect(
      as({ hospital: hospitalA }, (tx) => tx`DELETE FROM patient_portal_access WHERE id = ${accessA}`),
    ).rejects.toThrow(/permission denied|never deleted/);

    await expect(
      as({ hospital: hospitalA }, (tx) => tx`UPDATE patient_portal_access SET phone = '+919820055009' WHERE id = ${accessA}`),
    ).rejects.toThrow(/permission denied/);
  });
});
