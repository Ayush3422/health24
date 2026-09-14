import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { appRoleDb, resetDatabase, seedHospital, testDb, type SeededStaff } from './harness';

/**
 * Documents in the database (SP4 Phase 2): who sees them, who may write them,
 * and what can never change.
 *
 * Every case runs as the application role, so row-level security, column
 * grants and triggers all apply exactly as they do to the running API. Cases
 * that write run in transactions rolled back at the end.
 */
describe('documents: consent, writing and immutability', () => {
  let app: postgres.Sql;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let hospitalA: string;
  let hospitalB: string;
  let hospitalC: string;
  let clinicianA: SeededStaff;
  let frontDeskA: SeededStaff;
  let recordsA: SeededStaff;
  let adminA: SeededStaff;
  let frontDeskB: SeededStaff;

  /** Linked to A, B and C. */
  let patient: string;
  /** Linked to A only. */
  let patientOnlyAtA: string;

  /** A's lab report, dated 2026-03-15, with two files, scanned clean and available. */
  let reportA: string;
  let batchA: string;

  class Rollback {
    constructor(readonly value: unknown) {}
  }

  async function asTenant<T>(
    hospitalId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_hospital_id', ${hospitalId ?? ''}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  /** As `asTenant`, but always rolled back, so a case leaves no trace. */
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

  const switchTo = (tx: postgres.TransactionSql, hospitalId: string) =>
    tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;

  const keyFor = (hospitalId: string, patientId: string, documentId: string) =>
    `hospitals/${hospitalId}/patients/${patientId}/documents/${documentId}/${randomUUID()}`;

  async function insertDocument(
    tx: postgres.TransactionSql,
    overrides: {
      hospitalId?: string;
      patientId?: string;
      recordedBy?: string;
      reportDate?: string;
      orderingClinicianId?: string | null;
      orderingClinicianName?: string | null;
      importBatchId?: string | null;
    } = {},
  ): Promise<string> {
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO document_reference
        (patient_id, hospital_id, doc_type, report_date, recorded_by_staff_id,
         ordering_clinician_id, ordering_clinician_name, import_batch_id)
      VALUES (
        ${overrides.patientId ?? patient}, ${overrides.hospitalId ?? hospitalA}, 'lab_report',
        ${overrides.reportDate ?? '2026-03-15'}, ${overrides.recordedBy ?? frontDeskA.id},
        ${overrides.orderingClinicianId ?? null}, ${overrides.orderingClinicianName ?? null},
        ${overrides.importBatchId ?? null}
      )
      RETURNING id
    `;

    return row!.id;
  }

  async function insertFile(
    tx: postgres.TransactionSql,
    documentId: string,
    overrides: {
      position?: number;
      storageKey?: string;
      mimeType?: string;
      sizeBytes?: number;
      hospitalId?: string;
      patientId?: string;
    } = {},
  ): Promise<string> {
    const hospitalId = overrides.hospitalId ?? hospitalA;
    const patientId = overrides.patientId ?? patient;

    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO document_file
        (document_id, patient_id, hospital_id, position, storage_key, mime_type, size_bytes)
      VALUES (
        ${documentId}, ${patientId}, ${hospitalId}, ${overrides.position ?? 1},
        ${overrides.storageKey ?? keyFor(hospitalId, patientId, documentId)},
        ${overrides.mimeType ?? 'application/pdf'}, ${overrides.sizeBytes ?? 120_000}
      )
      RETURNING id
    `;

    return row!.id;
  }

  async function recordConsent(
    tx: postgres.TransactionSql,
    categories: string,
    options: { to?: string } = {},
  ): Promise<string> {
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO consent_artefact
        (patient_id, grantee_hospital_id, data_categories, date_range_to, expires_at,
         capture_method, recorded_by_staff_id)
      VALUES (${patient}, ${hospitalB}, ${categories}::clinical_data_category[], ${options.to ?? null},
              now() + interval '30 days', 'signed_form', ${frontDeskB.id})
      RETURNING id
    `;

    return row!.id;
  }

  const visible = async (tx: postgres.TransactionSql, table: string) =>
    (await tx.unsafe<Array<{ id: string }>>(`SELECT id FROM "${table}"`)).map((row) => row.id);

  beforeAll(async () => {
    await resetDatabase();

    const a = await seedHospital({ name: 'Sanjeevani Documents Test', mrnPrefix: 'SDO' });
    const b = await seedHospital({
      name: 'City General Documents Test',
      mrnPrefix: 'GDO',
      facilityType: 'allopathic',
    });
    const c = await seedHospital({
      name: 'Third Documents Test',
      mrnPrefix: 'TDO',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;
    hospitalC = c.hospital.id;
    clinicianA = a.staff.clinician as SeededStaff;
    frontDeskA = a.staff.frontDesk as SeededStaff;
    recordsA = a.staff.records as SeededStaff;
    adminA = a.staff.admin as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    [patient, patientOnlyAtA] = (await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const created = await tx<Array<{ id: string }>>`
        INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
        VALUES ('Kamala Documents', 'kamala documents', 'female', ${hospitalA}),
               ('Only At A', 'only at a', 'male', ${hospitalA})
        RETURNING id
      `;
      const [shared, onlyA] = created.map((row) => row.id) as [string, string];

      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn) VALUES
          (${shared}, ${hospitalA}, 'SDO-000001'),
          (${shared}, ${hospitalB}, 'GDO-000001'),
          (${shared}, ${hospitalC}, 'TDO-000001'),
          (${onlyA}, ${hospitalA}, 'SDO-000002')
      `;

      return [shared, onlyA];
    })) as [string, string];

    // A's report, uploaded by the front desk and scanned clean, the way the
    // application will write it.
    [reportA, batchA] = await asTenant(hospitalA, async (tx) => {
      const [batch] = await tx<Array<{ id: string }>>`
        INSERT INTO import_batch (patient_id, hospital_id, opened_by_staff_id)
        VALUES (${patient}, ${hospitalA}, ${recordsA.id})
        RETURNING id
      `;

      const report = await insertDocument(tx, { orderingClinicianId: clinicianA.id });
      await insertFile(tx, report, { position: 1 });
      await insertFile(tx, report, { position: 2, mimeType: 'image/jpeg' });

      await tx`
        UPDATE document_file
           SET scan_status = 'clean', scanned_at = now(), page_count = 1
         WHERE document_id = ${report}
      `;
      await tx`
        UPDATE document_reference
           SET availability = 'available', availability_changed_at = now()
         WHERE id = ${report}
      `;

      return [report, batch!.id];
    });
  });

  afterAll(async () => {
    for (const close of closers) await close();
  });

  describe('visibility', () => {
    it('shows the uploading hospital its document, files and import batch', async () => {
      const seen = await asTenant(hospitalA, async (tx) => ({
        documents: await visible(tx, 'document_reference'),
        files: (await visible(tx, 'document_file')).length,
        batches: await visible(tx, 'import_batch'),
      }));

      expect(seen).toEqual({ documents: [reportA], files: 2, batches: [batchA] });
    });

    it('shows another linked hospital nothing without consent, and nothing without a tenant', async () => {
      for (const hospital of [hospitalB, null]) {
        const seen = await asTenant(hospital, async (tx) => ({
          documents: await visible(tx, 'document_reference'),
          files: await visible(tx, 'document_file'),
          batches: await visible(tx, 'import_batch'),
        }));

        expect(seen).toEqual({ documents: [], files: [], batches: [] });
      }
    });

    it('reveals documents and their files under consent for documents — never the import batch', async () => {
      const seen = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, '{documents}');
        return {
          documents: await visible(tx, 'document_reference'),
          files: (await visible(tx, 'document_file')).length,
          batches: await visible(tx, 'import_batch'),
        };
      });

      expect(seen).toEqual({ documents: [reportA], files: 2, batches: [] });
    });

    it('does not reveal documents under consent for lab values alone', async () => {
      const seen = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, '{observations,diagnoses,notes}');
        return {
          documents: await visible(tx, 'document_reference'),
          files: await visible(tx, 'document_file'),
        };
      });

      expect(seen).toEqual({ documents: [], files: [] });
    });

    it('decides by the report date, and covers only the grantee', async () => {
      const seen = await rolledBack(hospitalB, async (tx) => {
        await recordConsent(tx, '{documents}', { to: '2026-03-14' });
        const outsideRange = await visible(tx, 'document_reference');

        await recordConsent(tx, '{documents}');
        const asGrantee = await visible(tx, 'document_reference');

        await switchTo(tx, hospitalC);
        const asAnotherLinkedHospital = await visible(tx, 'document_reference');

        return { outsideRange, asGrantee, asAnotherLinkedHospital };
      });

      expect(seen).toEqual({
        outsideRange: [],
        asGrantee: [reportA],
        asAnotherLinkedHospital: [],
      });
    });
  });

  describe('writing', () => {
    it('lets the front desk, records staff and clinicians upload', async () => {
      const ids = await rolledBack(hospitalA, async (tx) =>
        Promise.all(
          [frontDeskA, recordsA, clinicianA].map((staff) =>
            insertDocument(tx, { recordedBy: staff.id }),
          ),
        ),
      );

      expect(ids).toHaveLength(3);
    });

    it('refuses an upload recorded by the hospital admin, who never handles records', async () => {
      await expect(
        rolledBack(hospitalA, (tx) => insertDocument(tx, { recordedBy: adminA.id })),
      ).rejects.toThrow(/recorded by the front desk, records staff or a clinician/);
    });

    it('refuses a document for another hospital, or for a patient this one is not linked to', async () => {
      await expect(
        rolledBack(hospitalB, (tx) => insertDocument(tx, { recordedBy: frontDeskB.id })),
      ).rejects.toThrow(/row-level security/);

      await expect(
        rolledBack(hospitalA, (tx) => insertDocument(tx, { patientId: patientOnlyAtA })),
      ).resolves.toBeTruthy();

      await expect(
        rolledBack(hospitalB, (tx) =>
          insertDocument(tx, {
            hospitalId: hospitalB,
            patientId: patientOnlyAtA,
            recordedBy: frontDeskB.id,
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('names the ordering clinician by account or by name, never both, and only a clinician', async () => {
      await expect(
        rolledBack(hospitalA, (tx) =>
          insertDocument(tx, { orderingClinicianName: 'Dr. R. Menon (visiting)' }),
        ),
      ).resolves.toBeTruthy();

      await expect(
        rolledBack(hospitalA, (tx) =>
          insertDocument(tx, {
            orderingClinicianId: clinicianA.id,
            orderingClinicianName: 'Dr. R. Menon',
          }),
        ),
      ).rejects.toThrow(/document_reference_ordering_clinician_one/);

      await expect(
        rolledBack(hospitalA, (tx) => insertDocument(tx, { orderingClinicianId: recordsA.id })),
      ).rejects.toThrow(/ordering clinician must be a clinician/);
    });

    it('keeps a file’s storage key to identifiers naming its own hospital and patient', async () => {
      const cases = [
        `patients/Kamala Documents/lft.pdf`,
        keyFor(hospitalB, patient, randomUUID()),
        keyFor(hospitalA, patientOnlyAtA, randomUUID()),
      ];

      for (const storageKey of cases) {
        await expect(
          rolledBack(hospitalA, async (tx) =>
            insertFile(tx, await insertDocument(tx), { storageKey }),
          ),
          storageKey,
        ).rejects.toThrow(/document_file_storage_key_names_record/);
      }
    });

    it('accepts only PDF, JPEG and PNG, up to 25 MB, in positions from one', async () => {
      const refused = [
        [{ mimeType: 'text/html' }, /document_file_mime_type_allowed/],
        [{ sizeBytes: 25 * 1024 * 1024 + 1 }, /document_file_size_bounded/],
        [{ sizeBytes: 0 }, /document_file_size_bounded/],
        [{ position: 0 }, /document_file_position_from_one/],
      ] as const;

      for (const [overrides, error] of refused) {
        await expect(
          rolledBack(hospitalA, async (tx) => insertFile(tx, await insertDocument(tx), overrides)),
        ).rejects.toThrow(error);
      }
    });

    it('does not let another hospital add a file to a document it can read under consent', async () => {
      await expect(
        rolledBack(hospitalB, async (tx) => {
          await recordConsent(tx, '{documents}');
          return insertFile(tx, reportA);
        }),
      ).rejects.toThrow(/row-level security/);
    });

    it('does not let a file belong to another patient’s document', async () => {
      await expect(
        rolledBack(hospitalA, (tx) =>
          insertFile(tx, reportA, {
            // A free position, so only the same-record rule can refuse it.
            position: 3,
            patientId: patientOnlyAtA,
            storageKey: keyFor(hospitalA, patientOnlyAtA, reportA),
          }),
        ),
      ).rejects.toThrow(/document_file_document_same_record_fk/);
    });
  });

  describe('immutability', () => {
    it('refuses to change what a document says, or to delete it', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`UPDATE document_reference SET doc_type = 'radiology' WHERE id = ${reportA}`,
        ),
      ).rejects.toThrow(/permission denied/);

      await expect(
        rolledBack(hospitalA, (tx) => tx`DELETE FROM document_reference WHERE id = ${reportA}`),
      ).rejects.toThrow(/permission denied/);

      // Even the owner, in system context where row-level security admits the row.
      await expect(
        owner.begin(async (tx) => {
          await tx`SELECT set_config('app.system_context', 'on', true)`;
          await tx`UPDATE document_reference SET report_date = '2026-01-01' WHERE id = ${reportA}`;
        }),
      ).rejects.toThrow(/immutable/);
    });

    it('moves availability forward once, from pending to its outcome', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) =>
            tx`UPDATE document_reference SET availability = 'quarantined' WHERE id = ${reportA}`,
        ),
      ).rejects.toThrow(/cannot move from available to quarantined/);

      const outcome = await rolledBack(hospitalA, async (tx) => {
        const pending = await insertDocument(tx);
        await tx`
          UPDATE document_reference SET availability = 'quarantined', availability_changed_at = now()
           WHERE id = ${pending}
        `;
        return pending;
      });
      expect(outcome).toBeTruthy();

      await expect(
        rolledBack(hospitalA, async (tx) => {
          const pending = await insertDocument(tx);
          await tx`UPDATE document_reference SET availability = 'available' WHERE id = ${pending}`;
        }),
      ).rejects.toThrow(/document_reference_availability_consistent/);
    });

    it('records a file’s scan once, and an infected verdict with its signature', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) =>
            tx`UPDATE document_file SET scan_status = 'infected', scan_signature = 'x' WHERE document_id = ${reportA}`,
        ),
      ).rejects.toThrow(/cannot move from clean to infected/);

      await expect(
        rolledBack(hospitalA, async (tx) => {
          const document = await insertDocument(tx);
          const file = await insertFile(tx, document);
          await tx`UPDATE document_file SET scan_status = 'infected', scanned_at = now() WHERE id = ${file}`;
        }),
      ).rejects.toThrow(/document_file_scan_consistent/);

      await expect(
        rolledBack(
          hospitalA,
          (tx) =>
            tx`UPDATE document_file SET storage_key = ${keyFor(hospitalA, patient, reportA)} WHERE document_id = ${reportA}`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('marks a document entered in error only with a reason, and supersedes it only by a correction', async () => {
      await expect(
        rolledBack(
          hospitalA,
          (tx) =>
            tx`
            UPDATE document_reference
               SET version_status = 'entered_in_error', status_changed_at = now(),
                   status_changed_by_staff_id = ${recordsA.id}
             WHERE id = ${reportA}
          `,
        ),
      ).rejects.toThrow(/document_reference_version_status_consistent/);

      await expect(
        rolledBack(hospitalA, async (tx) => {
          await tx`
            UPDATE document_reference
               SET version_status = 'superseded', status_changed_at = now(),
                   status_changed_by_staff_id = ${recordsA.id}, status_reason = 'Wrong date'
             WHERE id = ${reportA}
          `;
          // The check is deferred to commit, which a rolled-back case never reaches.
          await tx`SET CONSTRAINTS ALL IMMEDIATE`;
        }),
      ).rejects.toThrow(/superseded only by a correction/);

      const corrected = await rolledBack(hospitalA, async (tx) => {
        await tx`
          UPDATE document_reference
             SET version_status = 'superseded', status_changed_at = now(),
                 status_changed_by_staff_id = ${recordsA.id}, status_reason = 'Wrong report date'
           WHERE id = ${reportA}
        `;
        const [next] = await tx<Array<{ id: string }>>`
          INSERT INTO document_reference
            (patient_id, hospital_id, doc_type, report_date, recorded_by_staff_id, supersedes_id,
             availability, availability_changed_at)
          VALUES (${patient}, ${hospitalA}, 'lab_report', '2026-03-16', ${recordsA.id}, ${reportA},
                  'available', now())
          RETURNING id
        `;
        // Deferred checks run at commit; force them here, inside the rolled-back transaction.
        await tx`SET CONSTRAINTS ALL IMMEDIATE`;
        return next!.id;
      });

      expect(corrected).toBeTruthy();
    });

    it('moves an import batch forward to done, and not back', async () => {
      await expect(
        rolledBack(hospitalA, async (tx) => {
          await tx`UPDATE import_batch SET status = 'classifying' WHERE id = ${batchA}`;
          await tx`UPDATE import_batch SET status = 'done', closed_at = now() WHERE id = ${batchA}`;
          return true;
        }),
      ).resolves.toBe(true);

      await expect(
        rolledBack(hospitalA, async (tx) => {
          await tx`UPDATE import_batch SET status = 'done', closed_at = now() WHERE id = ${batchA}`;
          await tx`UPDATE import_batch SET status = 'open' WHERE id = ${batchA}`;
        }),
      ).rejects.toThrow(/cannot move from done to open/);

      await expect(
        rolledBack(
          hospitalA,
          (tx) => tx`UPDATE import_batch SET status = 'done' WHERE id = ${batchA}`,
        ),
      ).rejects.toThrow(/import_batch_closed_consistent/);
    });
  });
});
