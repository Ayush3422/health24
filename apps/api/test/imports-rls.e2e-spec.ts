import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { appRoleDb, resetDatabase, seedHospital, testDb, type SeededStaff } from './harness';

/**
 * Legacy import in the database (SP4 Phase 6): an import's files and pages are
 * the hospital's own work in progress, a page is cut only from a clean file,
 * and a page is settled once — in a document of its own batch, or excluded
 * with a reason.
 *
 * Every case runs as the application role, so row-level security, column
 * grants and triggers apply exactly as they do to the running API. Cases that
 * write are rolled back.
 */
describe('imports: sharing, integrity and immutability', () => {
  let app: postgres.Sql;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let hospitalA: string;
  let hospitalB: string;
  let recordsA: SeededStaff;
  let adminA: SeededStaff;
  let frontDeskB: SeededStaff;

  /** Linked to A and B. */
  let patient: string;
  let batchA: string;
  let fileA: string;
  let pageA: string;
  /** A document classified from batch A. */
  let documentA: string;

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

  const visible = async (tx: postgres.TransactionSql, table: string) =>
    (await tx.unsafe<Array<{ id: string }>>(`SELECT id FROM "${table}"`)).map((row) => row.id);

  const fileKey = (hospitalId: string, patientId: string, batchId: string) =>
    `hospitals/${hospitalId}/patients/${patientId}/imports/${batchId}/files/${randomUUID()}`;

  const pageKey = (hospitalId: string, patientId: string, batchId: string) =>
    `hospitals/${hospitalId}/patients/${patientId}/imports/${batchId}/pages/${randomUUID()}`;

  async function insertFile(
    tx: postgres.TransactionSql,
    options: { position: number; clean?: boolean; storageKey?: string },
  ): Promise<string> {
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO import_file (batch_id, patient_id, hospital_id, position, storage_key, mime_type, size_bytes)
      VALUES (${batchA}, ${patient}, ${hospitalA}, ${options.position},
              ${options.storageKey ?? fileKey(hospitalA, patient, batchA)}, 'application/pdf', 400000)
      RETURNING id
    `;

    if (options.clean ?? true) {
      await tx`
        UPDATE import_file
           SET scan_status = 'clean', scanned_at = now(), sha256 = ${'a'.repeat(64)},
               upload_confirmed_at = now()
         WHERE id = ${row!.id}
      `;
    }

    return row!.id;
  }

  async function insertPage(tx: postgres.TransactionSql, fileId: string, pageNumber: number) {
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO import_page
        (batch_id, file_id, patient_id, hospital_id, page_number, storage_key, mime_type, size_bytes, sha256)
      VALUES (${batchA}, ${fileId}, ${patient}, ${hospitalA}, ${pageNumber},
              ${pageKey(hospitalA, patient, batchA)}, 'application/pdf', 9000, ${'b'.repeat(64)})
      RETURNING id
    `;
    return row!.id;
  }

  async function insertDocument(tx: postgres.TransactionSql, importBatchId: string | null) {
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO document_reference
        (patient_id, hospital_id, doc_type, report_date, recorded_by_staff_id, import_batch_id)
      VALUES (${patient}, ${hospitalA}, 'discharge_summary', '2016-04-02', ${recordsA.id}, ${importBatchId})
      RETURNING id
    `;
    return row!.id;
  }

  beforeAll(async () => {
    await resetDatabase();

    const a = await seedHospital({ name: 'Sanjeevani Imports RLS', mrnPrefix: 'SIR' });
    const b = await seedHospital({
      name: 'City General Imports RLS',
      mrnPrefix: 'GIR',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;
    recordsA = a.staff.records as SeededStaff;
    adminA = a.staff.admin as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    patient = await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [created] = await tx<Array<{ id: string }>>`
        INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
        VALUES ('Savitri Imports', 'savitri imports', 'female', ${hospitalA})
        RETURNING id
      `;

      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn) VALUES
          (${created!.id}, ${hospitalA}, 'SIR-000001'),
          (${created!.id}, ${hospitalB}, 'GIR-000001')
      `;

      return created!.id;
    }) as unknown as string;

    await asTenant(hospitalA, async (tx) => {
      const [batch] = await tx<Array<{ id: string }>>`
        INSERT INTO import_batch (patient_id, hospital_id, opened_by_staff_id)
        VALUES (${patient}, ${hospitalA}, ${recordsA.id})
        RETURNING id
      `;
      batchA = batch!.id;

      fileA = await insertFile(tx, { position: 1 });
      pageA = await insertPage(tx, fileA, 1);
      documentA = await insertDocument(tx, batchA);
    });
  });

  afterAll(async () => {
    for (const close of closers) await close();
  });

  it('shows the importing hospital its files and pages, and no one else — not even under consent', async () => {
    const own = await asTenant(hospitalA, async (tx) => ({
      files: await visible(tx, 'import_file'),
      pages: await visible(tx, 'import_page'),
    }));
    expect(own).toEqual({ files: [fileA], pages: [pageA] });

    for (const hospital of [hospitalB, null]) {
      const seen = await asTenant(hospital, async (tx) => ({
        files: await visible(tx, 'import_file'),
        pages: await visible(tx, 'import_page'),
      }));
      expect(seen).toEqual({ files: [], pages: [] });
    }

    const underConsent = await rolledBack(hospitalB, async (tx) => {
      await tx`
        INSERT INTO consent_artefact
          (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method, recorded_by_staff_id)
        VALUES (${patient}, ${hospitalB}, '{documents}'::clinical_data_category[],
                now() + interval '30 days', 'signed_form', ${frontDeskB.id})
      `;
      return { files: await visible(tx, 'import_file'), pages: await visible(tx, 'import_page') };
    });
    expect(underConsent).toEqual({ files: [], pages: [] });
  });

  it('refuses a file into another hospital’s batch', async () => {
    await expect(
      rolledBack(hospitalB, (tx) => insertFile(tx, { position: 2, clean: false })),
    ).rejects.toThrow(/row-level security/);
  });

  it('refuses a storage key that names another record', async () => {
    await expect(
      rolledBack(hospitalA, (tx) =>
        insertFile(tx, {
          position: 2,
          clean: false,
          storageKey: fileKey(hospitalA, randomUUID(), batchA),
        }),
      ),
    ).rejects.toThrow(/import_file_storage_key_names_record/);
  });

  it('cuts a page only from a file that scanned clean', async () => {
    await expect(
      rolledBack(hospitalA, async (tx) => {
        const pending = await insertFile(tx, { position: 2, clean: false });
        return insertPage(tx, pending, 1);
      }),
    ).rejects.toThrow(/a page is cut only from a file that scanned clean/);
  });

  it('puts a page in a document of its own batch only', async () => {
    await expect(
      rolledBack(hospitalA, async (tx) => {
        await tx`
          UPDATE import_page
             SET document_id = ${documentA}, classified_at = now(), classified_by_staff_id = ${recordsA.id}
           WHERE id = ${pageA}
        `;
        return true;
      }),
    ).resolves.toBe(true);

    await expect(
      rolledBack(hospitalA, async (tx) => {
        const unbatched = await insertDocument(tx, null);
        await tx`
          UPDATE import_page
             SET document_id = ${unbatched}, classified_at = now(), classified_by_staff_id = ${recordsA.id}
           WHERE id = ${pageA}
        `;
      }),
    ).rejects.toThrow(/import_page_document_same_batch_fk/);
  });

  it('settles a page once: never both classified and excluded, and never changed', async () => {
    await expect(
      rolledBack(hospitalA, async (tx) => {
        await tx`
          UPDATE import_page
             SET document_id = ${documentA}, classified_at = now(), classified_by_staff_id = ${recordsA.id}
           WHERE id = ${pageA}
        `;
        await tx`
          UPDATE import_page
             SET excluded_at = now(), excluded_by_staff_id = ${recordsA.id}, excluded_reason = 'Blank page'
           WHERE id = ${pageA}
        `;
      }),
    ).rejects.toThrow(/import_page_classified_or_excluded/);

    await expect(
      rolledBack(hospitalA, (tx) =>
        tx`
          UPDATE import_page SET excluded_at = now(), excluded_by_staff_id = ${recordsA.id}
           WHERE id = ${pageA}
        `,
      ),
    ).rejects.toThrow(/import_page_excluded_consistent/);

    await expect(
      rolledBack(hospitalA, async (tx) => {
        await tx`
          UPDATE import_page
             SET excluded_at = now(), excluded_by_staff_id = ${recordsA.id}, excluded_reason = 'Blank page'
           WHERE id = ${pageA}
        `;
        await tx`UPDATE import_page SET excluded_reason = 'Someone else’s report' WHERE id = ${pageA}`;
      }),
    ).rejects.toThrow(/is set once/);

    await expect(
      rolledBack(hospitalA, (tx) => tx`DELETE FROM import_page WHERE id = ${pageA}`),
    ).rejects.toThrow(/permission denied|never deleted/);
  });

  it('refuses the hospital admin as the one who excludes a page', async () => {
    await expect(
      rolledBack(hospitalA, (tx) =>
        tx`
          UPDATE import_page
             SET excluded_at = now(), excluded_by_staff_id = ${adminA.id}, excluded_reason = 'Blank page'
           WHERE id = ${pageA}
        `,
      ),
    ).rejects.toThrow(/recorded by the front desk, records staff or a clinician/);
  });

  it('lets nothing change but the lifecycle columns', async () => {
    await expect(
      rolledBack(hospitalA, (tx) =>
        tx`UPDATE import_page SET storage_key = ${pageKey(hospitalA, patient, batchA)} WHERE id = ${pageA}`,
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      rolledBack(hospitalA, (tx) => tx`UPDATE import_file SET position = 9 WHERE id = ${fileA}`),
    ).rejects.toThrow(/permission denied/);
  });

  it('takes no files and settles no pages once its batch is finished', async () => {
    await expect(
      rolledBack(hospitalA, async (tx) => {
        await tx`UPDATE import_batch SET status = 'done', closed_at = now() WHERE id = ${batchA}`;
        return insertFile(tx, { position: 2, clean: false });
      }),
    ).rejects.toThrow(/is finished/);

    await expect(
      rolledBack(hospitalA, async (tx) => {
        await tx`UPDATE import_batch SET status = 'done', closed_at = now() WHERE id = ${batchA}`;
        await tx`
          UPDATE import_page
             SET excluded_at = now(), excluded_by_staff_id = ${recordsA.id}, excluded_reason = 'Blank page'
           WHERE id = ${pageA}
        `;
      }),
    ).rejects.toThrow(/is finished/);
  });
});
