import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { appRoleDb, resetDatabase, seedHospital, testDb, type SeededStaff } from './harness';

/**
 * The clinical record's guarantees, tested at the database.
 *
 * Consent, immutability and correction are enforced by row-level security,
 * grants and triggers — so they are proven here, as the unprivileged
 * application role, without the API in the way. If a service later forgets
 * to check consent, these are the tests that say it would not have mattered.
 *
 * The fixture is the product's own story: a patient treated at an Ayurvedic
 * hospital (A) who then attends an allopathic one (B). Hospital C is linked to
 * the same patient but holds no consent, to prove a link alone is not enough.
 */
describe('clinical record: consent, immutability and correction', () => {
  let app: postgres.Sql;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let hospitalA: string;
  let hospitalB: string;
  let hospitalC: string;
  let clinicianA: SeededStaff;
  let clinicianB: SeededStaff;
  let frontDeskB: SeededStaff;
  let clinicianC: SeededStaff;

  /** Linked to A, B and C. */
  let patient: string;
  /** Linked to A only. */
  let patientOnlyAtA: string;

  let encounterA: string;
  let conditionA: string;
  let medicationA: string;
  let allergyA: string;
  let noteA: string;

  const CATEGORY_ROWS = [
    ['encounter', 'encounters'],
    ['condition', 'diagnoses'],
    ['medication_request', 'medications'],
    ['allergy_intolerance', 'allergies'],
    ['clinical_note', 'notes'],
  ] as const;

  /** Runs statements as the application role, under a tenant context, and commits. */
  async function asTenant<T>(
    hospitalId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_hospital_id', ${hospitalId ?? ''}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  class Rollback {
    constructor(readonly value: unknown) {}
  }

  /** Like `asTenant`, but always rolls back, so a test leaves no trace. */
  async function rolledBack<T>(
    hospitalId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    try {
      await asTenant(hospitalId, async (tx) => {
        throw new Rollback(await fn(tx));
      });
    } catch (caught) {
      if (caught instanceof Rollback) return caught.value as T;
      throw caught;
    }

    throw new Error('unreachable');
  }

  /** The owner, in system context: for arranging what the application cannot. */
  async function asOwner<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  async function visibleIds(hospitalId: string | null, table: string): Promise<string[]> {
    return asTenant(hospitalId, async (tx) => {
      const rows = await tx.unsafe<Array<{ id: string }>>(`SELECT id FROM "${table}"`);
      return rows.map((row) => row.id);
    });
  }

  function recordConsent(
    tx: postgres.TransactionSql,
    overrides: {
      patientId?: string;
      categories?: string;
      from?: string | null;
      to?: string | null;
      grantedAt?: string;
      expiresAt?: string;
      recordedBy?: string;
      grantee?: string;
    } = {},
  ) {
    return tx<Array<{ id: string }>>`
      INSERT INTO consent_artefact
        (patient_id, grantee_hospital_id, data_categories, date_range_from, date_range_to,
         granted_at, expires_at, capture_method, recorded_by_staff_id)
      VALUES (
        ${overrides.patientId ?? patient},
        ${overrides.grantee ?? hospitalB},
        ${overrides.categories ?? '{diagnoses,medications}'}::clinical_data_category[],
        ${overrides.from ?? null},
        ${overrides.to ?? null},
        ${overrides.grantedAt ?? new Date().toISOString()},
        ${overrides.expiresAt ?? new Date(Date.now() + 90 * 86_400_000).toISOString()},
        'signed_form',
        ${overrides.recordedBy ?? frontDeskB.id}
      )
      RETURNING id
    `;
  }

  beforeAll(async () => {
    await resetDatabase();

    const a = await seedHospital({ name: 'Sanjeevani Test', mrnPrefix: 'SJT' });
    const b = await seedHospital({
      name: 'City General Test',
      mrnPrefix: 'CGT',
      facilityType: 'allopathic',
    });
    const c = await seedHospital({
      name: 'Third Hospital Test',
      mrnPrefix: 'THT',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;
    hospitalC = c.hospital.id;
    clinicianA = a.staff.clinician as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;
    clinicianC = c.staff.clinician as SeededStaff;

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    [patient, patientOnlyAtA] = await asOwner(async (tx) => {
      const created = await tx<Array<{ id: string }>>`
        INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
        VALUES ('Kamala Amlapitta', 'kamala amlapitta', 'female', ${hospitalA}),
               ('Only At A', 'only at a', 'male', ${hospitalA})
        RETURNING id
      `;

      const [shared, onlyA] = created.map((row) => row.id) as [string, string];

      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn) VALUES
          (${shared}, ${hospitalA}, 'SJT-000001'),
          (${shared}, ${hospitalB}, 'CGT-000001'),
          (${shared}, ${hospitalC}, 'THT-000001'),
          (${onlyA}, ${hospitalA}, 'SJT-000002')
      `;

      return [shared, onlyA];
    });

    // Hospital A's record, written the way the application writes it.
    await asTenant(hospitalA, async (tx) => {
      const [encounter] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id)
        VALUES (${patient}, ${hospitalA}, 'outpatient', 'ayurveda', ${clinicianA.id})
        RETURNING id
      `;
      encounterA = encounter!.id;

      const [condition] = await tx<Array<{ id: string }>>`
        INSERT INTO condition (patient_id, hospital_id, encounter_id, is_primary, recorded_by_staff_id)
        VALUES (${patient}, ${hospitalA}, ${encounterA}, true, ${clinicianA.id})
        RETURNING id
      `;
      conditionA = condition!.id;

      await tx`
        INSERT INTO condition_coding (condition_id, role, code_system_key, code_system_version, code, display)
        VALUES (${conditionA}, 'primary', 'namaste', 'DEMO', 'DEMO-NAM-001', 'Amlapitta')
      `;

      const [medication] = await tx<Array<{ id: string }>>`
        INSERT INTO medication_request
          (patient_id, hospital_id, encounter_id, system_of_medicine, medicine_name,
           frequency, route, duration_value, duration_unit, vehicle, food_timing,
           recorded_by_staff_id)
        VALUES (${patient}, ${hospitalA}, ${encounterA}, 'ayurveda', 'Avipattikar churna',
                '1-0-1', 'oral', 4, 'months', 'warm water', 'before_food', ${clinicianA.id})
        RETURNING id
      `;
      medicationA = medication!.id;

      const [allergy] = await tx<Array<{ id: string }>>`
        INSERT INTO allergy_intolerance
          (patient_id, hospital_id, substance, category, criticality, recorded_by_staff_id)
        VALUES (${patient}, ${hospitalA}, 'Penicillin', 'medication', 'high', ${clinicianA.id})
        RETURNING id
      `;
      allergyA = allergy!.id;

      const [note] = await tx<Array<{ id: string }>>`
        INSERT INTO clinical_note
          (patient_id, hospital_id, encounter_id, template, body, recorded_by_staff_id)
        VALUES (${patient}, ${hospitalA}, ${encounterA}, 'ayurveda_initial',
                'Burning sensation after meals.', ${clinicianA.id})
        RETURNING id
      `;
      noteA = note!.id;
    });
  });

  afterAll(async () => {
    for (const close of closers) await close();
  });

  describe('visibility without consent', () => {
    it('shows the recording hospital its own record', async () => {
      expect(await visibleIds(hospitalA, 'condition')).toEqual([conditionA]);
      expect(await visibleIds(hospitalA, 'condition_coding')).toHaveLength(1);
    });

    it('shows another linked hospital nothing, in every category', async () => {
      for (const [table] of CATEGORY_ROWS) {
        expect(await visibleIds(hospitalB, table), table).toEqual([]);
      }

      expect(await visibleIds(hospitalB, 'condition_coding')).toEqual([]);
    });

    it('shows nothing at all without a tenant context', async () => {
      for (const [table] of CATEGORY_ROWS) {
        expect(await visibleIds(null, table), table).toEqual([]);
      }
    });

    it('does not reveal a row to a hospital that names it directly', async () => {
      const rows = await asTenant(
        hospitalB,
        (tx) => tx`SELECT id FROM condition WHERE id = ${conditionA}`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('consent', () => {
    it('reveals exactly the granted categories to the grantee', async () => {
      const seen = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, { categories: '{diagnoses,medications}' });

        const visible: Record<string, number> = {};
        for (const [table] of CATEGORY_ROWS) {
          const rows = await tx.unsafe(`SELECT id FROM "${table}"`);
          visible[table] = rows.length;
        }
        visible.condition_coding = (await tx`SELECT id FROM condition_coding`).length;

        return visible;
      });

      expect(seen).toEqual({
        encounter: 0,
        condition: 1,
        condition_coding: 1,
        medication_request: 1,
        allergy_intolerance: 0,
        clinical_note: 0,
      });
    });

    it('covers only the grantee, not every hospital the patient is linked to', async () => {
      await asTenant(hospitalB, (tx) => recordConsent(tx));

      try {
        expect(await visibleIds(hospitalB, 'condition')).toEqual([conditionA]);
        expect(await visibleIds(hospitalC, 'condition')).toEqual([]);
      } finally {
        // Revoked rather than deleted — deletion is not possible, as a later
        // test proves. Later tests start from no active consent.
        await asTenant(
          hospitalB,
          (tx) => tx`
          UPDATE consent_artefact
             SET status = 'revoked', revoked_at = now(),
                 revoked_by_staff_id = ${frontDeskB.id}, revocation_reason = 'test cleanup'
           WHERE status = 'active'
        `,
        );
      }
    });

    it('stops covering the record the moment it is revoked', async () => {
      expect(await visibleIds(hospitalB, 'condition')).toEqual([]);
    });

    it('does not cover a record outside its date range', async () => {
      const count = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, { from: '2019-01-01', to: '2020-12-31' });
        return (await tx`SELECT id FROM condition`).length;
      });

      expect(count).toBe(0);
    });

    it('does not cover anything once expired', async () => {
      const count = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, {
          grantedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
          expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        });
        return (await tx`SELECT id FROM condition`).length;
      });

      expect(count).toBe(0);
    });

    it('cannot be recorded for a patient the hospital is not linked to', async () => {
      await expect(
        rolledBack(hospitalB, (tx) => recordConsent(tx, { patientId: patientOnlyAtA })),
      ).rejects.toThrow(/row-level security/);
    });

    it('cannot be recorded on behalf of another hospital', async () => {
      await expect(
        rolledBack(hospitalC, (tx) => recordConsent(tx, { recordedBy: clinicianC.id })),
      ).rejects.toThrow(/row-level security/);
    });

    it('cannot be attributed to staff of a different hospital', async () => {
      await expect(
        rolledBack(hospitalB, (tx) => recordConsent(tx, { recordedBy: clinicianA.id })),
      ).rejects.toThrow(/consent_artefact_recorded_by_grantee_staff_fk/);
    });

    it('is not visible to hospitals it was not granted to', async () => {
      // B holds revoked artefacts from the tests above; C and A see none.
      expect(await visibleIds(hospitalB, 'consent_artefact')).not.toHaveLength(0);
      expect(await visibleIds(hospitalA, 'consent_artefact')).toEqual([]);
      expect(await visibleIds(hospitalC, 'consent_artefact')).toEqual([]);
    });

    it('cannot be un-revoked, edited or deleted', async () => {
      const [revoked] = await asTenant(
        hospitalB,
        (tx) => tx<Array<{ id: string }>>`
        SELECT id FROM consent_artefact WHERE status = 'revoked' LIMIT 1
      `,
      );

      await expect(
        asTenant(
          hospitalB,
          (tx) => tx`
          UPDATE consent_artefact SET status = 'active', revoked_at = NULL WHERE id = ${revoked!.id}
        `,
        ),
      ).rejects.toThrow(/set once|cannot move/);

      await expect(
        asTenant(
          hospitalB,
          (tx) => tx`
          UPDATE consent_artefact SET data_categories = '{notes}' WHERE id = ${revoked!.id}
        `,
        ),
      ).rejects.toThrow(/permission denied/);

      await expect(
        asTenant(hospitalB, (tx) => tx`DELETE FROM consent_artefact WHERE id = ${revoked!.id}`),
      ).rejects.toThrow(/permission denied/);
    });

    it('requires a witness for verbal consent', async () => {
      await expect(
        rolledBack(
          hospitalB,
          (tx) => tx`
          INSERT INTO consent_artefact
            (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method, recorded_by_staff_id)
          VALUES (${patient}, ${hospitalB}, '{diagnoses}', now() + interval '1 day',
                  'verbal_witnessed', ${frontDeskB.id})
        `,
        ),
      ).rejects.toThrow(/consent_artefact_verbal_has_witness/);
    });
  });

  describe('writing', () => {
    it('refuses to write into another hospital', async () => {
      await expect(
        rolledBack(
          hospitalB,
          (tx) => tx`
          INSERT INTO allergy_intolerance (patient_id, hospital_id, substance, category, recorded_by_staff_id)
          VALUES (${patient}, ${hospitalA}, 'Sulfa', 'medication', ${clinicianA.id})
        `,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('refuses a record for a patient the hospital is not linked to', async () => {
      await expect(
        rolledBack(
          hospitalB,
          (tx) => tx`
          INSERT INTO allergy_intolerance (patient_id, hospital_id, substance, category, recorded_by_staff_id)
          VALUES (${patientOnlyAtA}, ${hospitalB}, 'Sulfa', 'medication', ${clinicianB.id})
        `,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('cannot change another hospital’s record even where consent lets it read', async () => {
      const updated = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, { categories: '{diagnoses}' });
        expect((await tx`SELECT id FROM condition`).length).toBe(1);

        return tx`
          UPDATE condition
             SET version_status = 'entered_in_error', status_changed_at = now(),
                 status_changed_by_staff_id = ${clinicianB.id}, status_reason = 'not mine to change'
           WHERE id = ${conditionA}
        `;
      });

      expect(updated.count).toBe(0);
    });

    it('refuses a record attributed to another hospital’s staff', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`
          INSERT INTO allergy_intolerance (patient_id, hospital_id, substance, category, recorded_by_staff_id)
          VALUES (${patient}, ${hospitalA}, 'Sulfa', 'medication', ${clinicianB.id})
        `,
        ),
      ).rejects.toThrow(/allergy_intolerance_recorded_by_same_hospital_fk/);
    });

    it('refuses a diagnosis filed under another patient’s encounter', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`
          INSERT INTO condition (patient_id, hospital_id, encounter_id, recorded_by_staff_id)
          VALUES (${patientOnlyAtA}, ${hospitalA}, ${encounterA}, ${clinicianA.id})
        `,
        ),
      ).rejects.toThrow(/condition_encounter_same_record_fk/);
    });

    it('refuses a primary coding that claims a mapping', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`
          INSERT INTO condition_coding (condition_id, role, code_system_key, code_system_version, code, display, equivalence)
          VALUES (${conditionA}, 'translated', 'icd11-tm2', 'DEMO', 'DEMO-TM2-01', 'x', NULL)
        `,
        ),
      ).rejects.toThrow(/condition_coding_primary_has_no_mapping/);
    });
  });

  describe('immutability', () => {
    it('refuses to edit clinical content, as the application', async () => {
      await expect(
        asTenant(
          hospitalA,
          (tx) => tx`UPDATE clinical_note SET body = 'rewritten' WHERE id = ${noteA}`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses to edit clinical content even as the table owner', async () => {
      // Grants do not bind the owner; the trigger does.
      await expect(
        asOwner((tx) => tx`UPDATE clinical_note SET body = 'rewritten' WHERE id = ${noteA}`),
      ).rejects.toThrow(/immutable/);

      await expect(
        asOwner(
          (tx) => tx`UPDATE condition_coding SET code = 'OTHER' WHERE condition_id = ${conditionA}`,
        ),
      ).rejects.toThrow(/immutable/);
    });

    it('refuses to delete, as the application and as the owner', async () => {
      await expect(
        asTenant(hospitalA, (tx) => tx`DELETE FROM medication_request WHERE id = ${medicationA}`),
      ).rejects.toThrow(/permission denied/);

      await expect(
        asOwner((tx) => tx`DELETE FROM medication_request WHERE id = ${medicationA}`),
      ).rejects.toThrow(/never deleted/);
    });

    it('lets a medicine be stopped once, with a reason, and not restarted', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`
          UPDATE medication_request SET status = 'stopped', ended_at = now() WHERE id = ${medicationA}
        `,
        ),
      ).rejects.toThrow(/medication_request_end_matches_status/);

      await asTenant(
        hospitalA,
        (tx) => tx`
        UPDATE medication_request
           SET status = 'stopped', ended_at = now(),
               ended_by_staff_id = ${clinicianA.id}, end_reason = 'Symptoms resolved'
         WHERE id = ${medicationA}
      `,
      );

      await expect(
        asTenant(
          hospitalA,
          (tx) => tx`
          UPDATE medication_request SET status = 'active', ended_at = NULL WHERE id = ${medicationA}
        `,
        ),
      ).rejects.toThrow(/cannot move|set once/);
    });

    it('lets an encounter finish, and not reopen', async () => {
      await asTenant(
        hospitalA,
        (tx) => tx`
        UPDATE encounter SET status = 'finished', ended_at = now() WHERE id = ${encounterA}
      `,
      );

      await expect(
        asTenant(
          hospitalA,
          (tx) => tx`
          UPDATE encounter SET status = 'in_progress', ended_at = NULL WHERE id = ${encounterA}
        `,
        ),
      ).rejects.toThrow(/cannot move|set once/);
    });
  });

  describe('correction', () => {
    it('requires a reason to mark an entry entered in error', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`
          UPDATE allergy_intolerance
             SET version_status = 'entered_in_error', status_changed_at = now()
           WHERE id = ${allergyA}
        `,
        ),
      ).rejects.toThrow(/allergy_intolerance_version_status_consistent/);
    });

    it('refuses to mark an entry superseded without a correction that points at it', async () => {
      await expect(
        asTenant(
          hospitalA,
          (tx) => tx`
          UPDATE allergy_intolerance
             SET version_status = 'superseded', status_changed_at = now(),
                 status_changed_by_staff_id = ${clinicianA.id}, status_reason = 'orphaned'
           WHERE id = ${allergyA}
        `,
        ),
      ).rejects.toThrow(/superseded only by a correction/);
    });

    it('refuses a correction that leaves the original current', async () => {
      await expect(
        asTenant(
          hospitalA,
          (tx) => tx`
          INSERT INTO allergy_intolerance
            (patient_id, hospital_id, substance, category, criticality, recorded_by_staff_id, supersedes_id)
          VALUES (${patient}, ${hospitalA}, 'Penicillin', 'medication', 'low', ${clinicianA.id}, ${allergyA})
        `,
        ),
      ).rejects.toThrow(/must mark the entry it replaces as superseded/);
    });

    it('records a correction as a new version and keeps the original', async () => {
      const correctionId = await asTenant(hospitalA, async (tx) => {
        const [correction] = await tx<Array<{ id: string }>>`
          INSERT INTO allergy_intolerance
            (patient_id, hospital_id, substance, category, criticality, reaction,
             recorded_by_staff_id, supersedes_id)
          VALUES (${patient}, ${hospitalA}, 'Penicillin', 'medication', 'high', 'Anaphylaxis',
                  ${clinicianA.id}, ${allergyA})
          RETURNING id
        `;

        await tx`
          UPDATE allergy_intolerance
             SET version_status = 'superseded', status_changed_at = now(),
                 status_changed_by_staff_id = ${clinicianA.id}, status_reason = 'Reaction documented'
           WHERE id = ${allergyA}
        `;

        return correction!.id;
      });

      const rows = await asTenant(
        hospitalA,
        (tx) =>
          tx<
            Array<{ id: string; version_status: string; supersedes_id: string | null }>
          >`SELECT id, version_status, supersedes_id FROM allergy_intolerance ORDER BY recorded_at`,
      );

      expect(rows).toEqual([
        { id: allergyA, version_status: 'superseded', supersedes_id: null },
        { id: correctionId, version_status: 'current', supersedes_id: allergyA },
      ]);
    });

    it('refuses a second correction of the same entry', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`
          INSERT INTO allergy_intolerance
            (patient_id, hospital_id, substance, category, recorded_by_staff_id, supersedes_id)
          VALUES (${patient}, ${hospitalA}, 'Penicillin', 'medication', ${clinicianA.id}, ${allergyA})
        `,
        ),
      ).rejects.toThrow(/allergy_intolerance_supersedes_once/);
    });

    it('refuses a superseded entry being brought back', async () => {
      await expect(
        asTenant(
          hospitalA,
          (tx) => tx`
          UPDATE allergy_intolerance SET version_status = 'current' WHERE id = ${allergyA}
        `,
        ),
      ).rejects.toThrow(/cannot move|version_status_consistent/);
    });
  });

  describe('merged records', () => {
    it('extends consent on the surviving record to rows recorded on the merged one', async () => {
      // Hospital A's second record for the same person, later merged into the
      // shared one. Its diagnosis keeps the id it was recorded against.
      const mergedCondition = await asTenant(hospitalA, async (tx) => {
        const [encounter] = await tx<Array<{ id: string }>>`
          INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id)
          VALUES (${patientOnlyAtA}, ${hospitalA}, 'outpatient', 'ayurveda', ${clinicianA.id})
          RETURNING id
        `;
        const [condition] = await tx<Array<{ id: string }>>`
          INSERT INTO condition (patient_id, hospital_id, encounter_id, recorded_by_staff_id)
          VALUES (${patientOnlyAtA}, ${hospitalA}, ${encounter!.id}, ${clinicianA.id})
          RETURNING id
        `;
        return condition!.id;
      });

      const before = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, { categories: '{diagnoses}' });
        return (await tx`SELECT id FROM condition`).map((row) => row.id as string);
      });
      expect(before).toEqual([conditionA]);

      await asOwner(
        (tx) => tx`
        INSERT INTO patient_merge_alias (merged_patient_id, surviving_patient_id)
        VALUES (${patientOnlyAtA}, ${patient})
      `,
      );

      try {
        const after = await rolledBack(hospitalB, async (tx) => {
          await recordConsent(tx, { categories: '{diagnoses}' });
          return (await tx`SELECT id FROM condition`).map((row) => row.id as string);
        });

        expect(after.sort()).toEqual([conditionA, mergedCondition].sort());
      } finally {
        await asOwner(
          (tx) => tx`
          DELETE FROM patient_merge_alias WHERE merged_patient_id = ${patientOnlyAtA}
        `,
        );
      }
    });

    it('cannot have an alias written by a hospital', async () => {
      await expect(
        rolledBack(
          hospitalB,
          (tx) => tx`
          INSERT INTO patient_merge_alias (merged_patient_id, surviving_patient_id)
          VALUES (${patientOnlyAtA}, ${patient})
        `,
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });
});
