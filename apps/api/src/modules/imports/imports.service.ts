import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type {
  AddImportFilesInput,
  ClassifyImportPagesInput,
  DocumentFileUrl,
  ExcludeImportPagesInput,
  ExternalClinicianNames,
  ImportBatchDocument,
  ImportBatchList,
  ImportBatchListItem,
  ImportBatchSummary,
  ImportFileSummary,
  ImportFilesAdded,
  ImportPageSummary,
  OpenImportBatchInput,
} from '@health24/shared';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { documentFiles, documentReferences, importBatches, importFiles } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  istToday,
  requireLinkedPatient,
  toIso,
  violatedConstraint,
} from '../clinical/clinical-access';
import { ABANDON_AFTER_MS } from '../documents/documents.service';
import { ScanQueue } from '../scanning/scan-queue';
import { documentFileKey, importFileKey } from '../storage/keys';
import { StorageService } from '../storage/storage.service';

type BatchRow = {
  id: string;
  patient_id: string;
  hospital_id: string;
  status: ImportBatchSummary['status'];
  note: string | null;
  opened_by_staff_id: string;
  opened_by_name: string | null;
  created_at: string | Date;
  closed_at: string | Date | null;
  files: number;
  files_in_progress: number;
  files_quarantined: number;
  pages: number;
  classified: number;
  excluded: number;
};

type PageRow = {
  id: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  document_id: string | null;
  excluded_at: string | Date | null;
};

const BATCH_SELECT = sql`
  SELECT b."id", b."patient_id", b."hospital_id", b."status", b."note", b."opened_by_staff_id",
         s."name" AS opened_by_name, b."created_at", b."closed_at",
         (SELECT count(*) FROM "import_file" f WHERE f."batch_id" = b."id")::int AS files,
         (SELECT count(*) FROM "import_file" f
           WHERE f."batch_id" = b."id" AND f."abandoned_at" IS NULL
             AND (f."scan_status" = 'pending'
                  OR (f."scan_status" = 'clean' AND f."pages_created_at" IS NULL)))::int AS files_in_progress,
         (SELECT count(*) FROM "import_file" f
           WHERE f."batch_id" = b."id" AND f."scan_status" = 'infected')::int AS files_quarantined,
         (SELECT count(*) FROM "import_page" p WHERE p."batch_id" = b."id")::int AS pages,
         (SELECT count(*) FROM "import_page" p
           WHERE p."batch_id" = b."id" AND p."document_id" IS NOT NULL)::int AS classified,
         (SELECT count(*) FROM "import_page" p
           WHERE p."batch_id" = b."id" AND p."excluded_at" IS NOT NULL)::int AS excluded
    FROM "import_batch" b
    LEFT JOIN "staff_user" s ON s."id" = b."opened_by_staff_id"
`;

const idList = (ids: string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * Legacy paper files (sp4-plan.md, Phase 6, Decision E1).
 *
 * An import is the hospital's own work in progress: never shared, and never
 * opened by the front desk, because classifying a page means reading it.
 * Documents made from pages are ordinary documents from then on — listed,
 * consented, corrected and withdrawn like any other.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly scans: ScanQueue,
  ) {}

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  async open(
    actor: Actor,
    input: OpenImportBatchInput,
    meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    const hospitalId = requireHospital(actor);
    const patientId = input.patientId.toLowerCase();
    const batchId = uuidv7();

    const summary = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      await tx.insert(importBatches).values({
        id: batchId,
        patientId,
        hospitalId,
        openedByStaffId: actor.staffUserId,
        note: input.note ?? null,
      });

      return this.summary(tx, hospitalId, batchId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'import_batch',
      resourceId: batchId,
      patientId,
      action: 'create',
      meta,
    });

    return summary;
  }

  async list(actor: Actor, patientId: string, meta: RequestMeta): Promise<ImportBatchList> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await tx.execute<BatchRow>(sql`
        ${BATCH_SELECT}
         WHERE b."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
           AND b."hospital_id" = ${hospitalId}::uuid
      ORDER BY b."created_at" DESC
      `);
      return [...found];
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'import_batch',
      patientId,
      action: 'search',
      meta,
    });

    return { batches: rows.map((row) => this.toListItem(row)) };
  }

  async get(actor: Actor, batchId: string, meta: RequestMeta): Promise<ImportBatchSummary> {
    const hospitalId = requireHospital(actor);
    const summary = await this.db.asTenant(hospitalId, (tx) =>
      this.summary(tx, hospitalId, batchId),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'import_batch',
      resourceId: batchId,
      patientId: summary.patientId,
      action: 'read',
      meta,
    });

    return summary;
  }

  /** Every page settled and no file still in progress: the batch is done, and stays done. */
  async finish(actor: Actor, batchId: string, meta: RequestMeta): Promise<ImportBatchSummary> {
    const hospitalId = requireHospital(actor);

    const summary = await this.db.asTenant(hospitalId, async (tx) => {
      await this.requireBatch(tx, hospitalId, batchId, { open: true });
      const current = await this.summary(tx, hospitalId, batchId);

      if (!current.canFinish) {
        const { files, filesInProgress, unassigned } = current.progress;
        throw new ConflictException(
          files === 0
            ? 'Upload the folder before finishing the import'
            : filesInProgress > 0
              ? `${filesInProgress} file(s) are still being uploaded, checked or cut into pages`
              : `${unassigned} page(s) are neither in a document nor excluded`,
        );
      }

      await tx.execute(sql`
        UPDATE "import_batch" SET "status" = 'done', "closed_at" = now()
         WHERE "id" = ${batchId}::uuid AND "status" <> 'done'
      `);

      return this.summary(tx, hospitalId, batchId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'import_batch',
      resourceId: batchId,
      patientId: summary.patientId,
      action: 'update',
      meta,
    });

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /** Records the next files of the folder and returns one presigned upload per file. */
  async addFiles(
    actor: Actor,
    batchId: string,
    input: AddImportFilesInput,
    meta: RequestMeta,
  ): Promise<ImportFilesAdded> {
    const hospitalId = requireHospital(actor);

    const { summary, files } = await this.db.asTenant(hospitalId, async (tx) => {
      const batch = await this.requireBatch(tx, hospitalId, batchId, { open: true });

      const [last] = await tx.execute<{ position: number }>(sql`
        SELECT coalesce(max("position"), 0)::int AS position
          FROM "import_file" WHERE "batch_id" = ${batchId}::uuid
      `);

      const planned = input.files.map((file, index) => {
        const fileId = uuidv7();
        return {
          id: fileId,
          position: (last?.position ?? 0) + index + 1,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          storageKey: importFileKey({
            hospitalId,
            patientId: batch.patient_id,
            batchId,
            fileId,
          }),
        };
      });

      try {
        await tx.insert(importFiles).values(
          planned.map((file) => ({
            id: file.id,
            batchId,
            patientId: batch.patient_id,
            hospitalId,
            position: file.position,
            storageKey: file.storageKey,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          })),
        );
      } catch (error) {
        if (violatedConstraint(error) === 'import_file_position_once') {
          throw new ConflictException(
            'Another upload to this import started at the same moment. Try again.',
          );
        }
        throw error;
      }

      return { summary: await this.summary(tx, hospitalId, batchId), files: planned };
    });

    const uploads = await Promise.all(
      files.map(async (file) => {
        const signed = await this.storage.presignUpload({
          key: file.storageKey,
          contentType: file.mimeType,
          contentLength: file.sizeBytes,
        });

        return { fileId: file.id, position: file.position, ...signed };
      }),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'import_batch',
      resourceId: batchId,
      patientId: summary.patientId,
      action: 'update',
      meta,
    });

    return { batch: summary, uploads };
  }

  /**
   * The uploader says the files have arrived. Each unconfirmed file is checked
   * against what was declared, then queued for scanning. Safe to repeat.
   */
  async completeFiles(
    actor: Actor,
    batchId: string,
    meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    const hospitalId = requireHospital(actor);

    const pending = await this.db.asTenant(hospitalId, async (tx) => {
      await this.requireBatch(tx, hospitalId, batchId, { open: true });

      const found = await tx.execute<{
        id: string;
        position: number;
        storage_key: string;
        mime_type: string;
        size_bytes: number;
        scan_status: string;
      }>(sql`
        SELECT "id", "position", "storage_key", "mime_type", "size_bytes", "scan_status"
          FROM "import_file"
         WHERE "batch_id" = ${batchId}::uuid
           AND "upload_confirmed_at" IS NULL AND "abandoned_at" IS NULL
      ORDER BY "position"
      `);
      return [...found];
    });

    const problems: string[] = [];

    for (const file of pending) {
      const stored = await this.storage.describe(file.storage_key);

      if (!stored) {
        problems.push(`File ${file.position} has not been uploaded`);
      } else if (stored.size !== file.size_bytes || stored.contentType !== file.mime_type) {
        problems.push(`File ${file.position} does not match what was declared`);
      }
    }

    if (problems.length > 0) {
      throw new ConflictException(problems.join('; '));
    }

    // Queued before the confirmation is recorded, as for documents.
    for (const file of pending) {
      if (file.scan_status === 'pending') await this.scans.enqueue(file.storage_key);
    }

    const summary = await this.db.asTenant(hospitalId, async (tx) => {
      if (pending.length > 0) {
        await tx.execute(sql`
          UPDATE "import_file" SET "upload_confirmed_at" = now()
           WHERE "id" IN (${idList(pending.map((file) => file.id))})
             AND "upload_confirmed_at" IS NULL AND "abandoned_at" IS NULL
        `);
      }
      return this.summary(tx, hospitalId, batchId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'import_batch',
      resourceId: batchId,
      patientId: summary.patientId,
      action: 'update',
      meta,
    });

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------

  /** A one-minute link to one page, so it can be read and classified. Every link is audited. */
  async pageUrl(
    actor: Actor,
    batchId: string,
    pageId: string,
    meta: RequestMeta,
  ): Promise<DocumentFileUrl> {
    const hospitalId = requireHospital(actor);

    const { patientId, key } = await this.db.asTenant(hospitalId, async (tx) => {
      const batch = await this.requireBatch(tx, hospitalId, batchId);
      const [page] = await tx.execute<{ storage_key: string }>(sql`
        SELECT "storage_key" FROM "import_page"
         WHERE "id" = ${pageId}::uuid AND "batch_id" = ${batchId}::uuid
      `);

      if (!page) throw new NotFoundException('Page not found');
      return { patientId: batch.patient_id, key: page.storage_key };
    });

    const signed = await this.storage.presignDownload({ key, disposition: 'inline' });

    await this.audit.recordForActor(actor, {
      resourceType: 'import_page',
      resourceId: pageId,
      patientId,
      action: 'read',
      meta,
    });

    return { ...signed, disposition: 'inline' };
  }

  /**
   * Makes one document from pages, in the order given. Each page is copied
   * inside storage to the new document's own key, with the checksum it was
   * cut with; the document is available at once, its pages having come from
   * files that scanned clean.
   */
  async classify(
    actor: Actor,
    batchId: string,
    input: ClassifyImportPagesInput,
    meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    const hospitalId = requireHospital(actor);
    const pageIds = input.pageIds.map((id) => id.toLowerCase());

    if (input.reportDate > istToday()) {
      throw new BadRequestException('The report date cannot be in the future');
    }

    const { patientId, pages } = await this.db.asTenant(hospitalId, async (tx) => {
      const batch = await this.requireBatch(tx, hospitalId, batchId, { open: true });
      return { patientId: batch.patient_id, pages: await this.unsettledPages(tx, batchId, pageIds) };
    });

    const documentId = uuidv7();
    const files = pageIds.map((pageId, index) => {
      const page = pages.get(pageId)!;
      const fileId = uuidv7();

      return {
        id: fileId,
        position: index + 1,
        from: page.storage_key,
        storageKey: documentFileKey({ hospitalId, patientId, documentId, fileId }),
        mimeType: page.mime_type,
        sizeBytes: page.size_bytes,
        sha256: page.sha256,
      };
    });

    for (const file of files) await this.storage.copy(file.from, file.storageKey);

    let summary: ImportBatchSummary;

    try {
      summary = await this.db.asTenant(hospitalId, async (tx) => {
        await tx.insert(documentReferences).values({
          id: documentId,
          patientId,
          hospitalId,
          importBatchId: batchId,
          docType: input.docType,
          title: input.title ?? null,
          reportDate: input.reportDate,
          performingFacility: input.performingFacility ?? null,
          orderingClinicianId: input.orderingClinicianId ?? null,
          orderingClinicianName: input.orderingClinicianName ?? null,
          availability: 'available',
          availabilityChangedAt: sql`now()`,
          uploadConfirmedAt: sql`now()`,
          recordedByStaffId: actor.staffUserId,
        });

        await tx.insert(documentFiles).values(
          files.map((file) => ({
            id: file.id,
            documentId,
            patientId,
            hospitalId,
            position: file.position,
            storageKey: file.storageKey,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            scanStatus: 'clean' as const,
            scannedAt: sql`now()`,
            pageCount: file.mimeType === 'application/pdf' ? 1 : null,
          })),
        );

        const claimed = await tx.execute<{ id: string }>(sql`
          UPDATE "import_page"
             SET "document_id" = ${documentId}::uuid, "classified_at" = now(),
                 "classified_by_staff_id" = ${actor.staffUserId}::uuid
           WHERE "batch_id" = ${batchId}::uuid AND "id" IN (${idList(pageIds)})
             AND "document_id" IS NULL AND "excluded_at" IS NULL
       RETURNING "id"
        `);

        if ([...claimed].length !== pageIds.length) {
          throw new ConflictException(
            'Some of these pages were classified or excluded by someone else a moment ago',
          );
        }

        await this.markClassifying(tx, batchId);
        return this.summary(tx, hospitalId, batchId);
      });
    } catch (error) {
      // Never part of the record: the copies go.
      for (const file of files) {
        await this.storage.remove(file.storageKey).catch(() => undefined);
      }
      throw this.translate(error);
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'document_reference',
      resourceId: documentId,
      patientId,
      action: 'create',
      meta,
    });
    await this.audit.recordForActor(actor, {
      resourceType: 'import_batch',
      resourceId: batchId,
      patientId,
      action: 'update',
      meta,
    });

    return summary;
  }

  /** Pages that are not part of this patient's record: kept, with the reason, never deleted. */
  async exclude(
    actor: Actor,
    batchId: string,
    input: ExcludeImportPagesInput,
    meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    const hospitalId = requireHospital(actor);
    const pageIds = input.pageIds.map((id) => id.toLowerCase());

    const summary = await this.db.asTenant(hospitalId, async (tx) => {
      await this.requireBatch(tx, hospitalId, batchId, { open: true });
      await this.unsettledPages(tx, batchId, pageIds);

      const excluded = await tx.execute<{ id: string }>(sql`
        UPDATE "import_page"
           SET "excluded_at" = now(), "excluded_by_staff_id" = ${actor.staffUserId}::uuid,
               "excluded_reason" = ${input.reason}
         WHERE "batch_id" = ${batchId}::uuid AND "id" IN (${idList(pageIds)})
           AND "document_id" IS NULL AND "excluded_at" IS NULL
     RETURNING "id"
      `);

      if ([...excluded].length !== pageIds.length) {
        throw new ConflictException(
          'Some of these pages were classified or excluded by someone else a moment ago',
        );
      }

      await this.markClassifying(tx, batchId);
      return this.summary(tx, hospitalId, batchId);
    });

    for (const pageId of pageIds) {
      await this.audit.recordForActor(actor, {
        resourceType: 'import_page',
        resourceId: pageId,
        patientId: summary.patientId,
        action: 'update',
        meta,
      });
    }

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Doctors without an account
  // ---------------------------------------------------------------------------

  /**
   * Names this hospital has already given doctors without an account, so the
   * same doctor is named the same way on every document.
   */
  async externalClinicianNames(actor: Actor, q: string | undefined): Promise<ExternalClinicianNames> {
    const hospitalId = requireHospital(actor);
    const pattern = q ? `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : '%';

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<{ name: string }>(sql`
        SELECT DISTINCT btrim("ordering_clinician_name") AS name
          FROM "document_reference"
         WHERE "hospital_id" = ${hospitalId}::uuid
           AND "ordering_clinician_name" IS NOT NULL
           AND "version_status" = 'current'
           AND "ordering_clinician_name" ILIKE ${pattern}
      ORDER BY 1
         LIMIT 20
      `),
    );

    return { names: [...rows].map((row) => row.name) };
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  /** Import files never confirmed within a day: removed from storage and marked abandoned. */
  async abandonStale(olderThanMs = ABANDON_AFTER_MS): Promise<number> {
    const hospitals = await this.db.raw.execute<{ id: string }>(
      sql`SELECT "id" FROM "hospital_directory"`,
    );
    let abandoned = 0;

    for (const { id: hospitalId } of hospitals) {
      const stale = await this.db.asTenant(hospitalId, async (tx) => {
        const found = await tx.execute<{ id: string; storage_key: string }>(sql`
          SELECT "id", "storage_key" FROM "import_file"
           WHERE "hospital_id" = ${hospitalId}::uuid
             AND "upload_confirmed_at" IS NULL AND "abandoned_at" IS NULL
             AND "created_at" < now() - make_interval(secs => ${olderThanMs / 1000})
        `);
        return [...found];
      });

      for (const file of stale) {
        await this.storage.remove(file.storage_key);
        await this.db.asTenant(hospitalId, (tx) =>
          tx.execute(sql`
            UPDATE "import_file" SET "abandoned_at" = now()
             WHERE "id" = ${file.id}::uuid AND "upload_confirmed_at" IS NULL AND "abandoned_at" IS NULL
          `),
        );
        abandoned += 1;
      }
    }

    if (abandoned > 0) this.logger.log(`Abandoned ${abandoned} import file(s) never completed`);
    return abandoned;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async requireBatch(
    tx: DbTransaction,
    hospitalId: string,
    batchId: string,
    options: { open?: boolean } = {},
  ): Promise<BatchRow> {
    const [row] = await tx.execute<BatchRow>(sql`${BATCH_SELECT} WHERE b."id" = ${batchId}::uuid`);

    if (!row || row.hospital_id !== hospitalId) throw new NotFoundException('Import not found');
    if (options.open && row.status === 'done') {
      throw new ConflictException('This import is finished');
    }

    return row;
  }

  /** The named pages of this batch, each neither classified nor excluded. */
  private async unsettledPages(
    tx: DbTransaction,
    batchId: string,
    pageIds: string[],
  ): Promise<Map<string, PageRow>> {
    const rows = await tx.execute<PageRow>(sql`
      SELECT "id", "storage_key", "mime_type", "size_bytes", "sha256", "document_id", "excluded_at"
        FROM "import_page"
       WHERE "batch_id" = ${batchId}::uuid AND "id" IN (${idList(pageIds)})
    `);
    const pages = new Map([...rows].map((row) => [row.id, row]));

    if (pages.size !== pageIds.length) {
      throw new BadRequestException('Some of these pages are not part of this import');
    }
    if ([...pages.values()].some((page) => page.document_id || page.excluded_at)) {
      throw new ConflictException('Some of these pages are already in a document or excluded');
    }

    return pages;
  }

  private async markClassifying(tx: DbTransaction, batchId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE "import_batch" SET "status" = 'classifying'
       WHERE "id" = ${batchId}::uuid AND "status" = 'open'
    `);
  }

  private async summary(
    tx: DbTransaction,
    hospitalId: string,
    batchId: string,
  ): Promise<ImportBatchSummary> {
    const batch = await this.requireBatch(tx, hospitalId, batchId);

    const files = await tx.execute<{
      id: string;
      position: number;
      mime_type: ImportFileSummary['mimeType'];
      size_bytes: number;
      upload_confirmed: boolean;
      abandoned: boolean;
      scan_status: ImportFileSummary['scanStatus'];
      page_count: number | null;
      pages_ready: boolean;
    }>(sql`
      SELECT "id", "position", "mime_type", "size_bytes",
             "upload_confirmed_at" IS NOT NULL AS upload_confirmed,
             "abandoned_at" IS NOT NULL AS abandoned,
             "scan_status", "page_count", "pages_created_at" IS NOT NULL AS pages_ready
        FROM "import_file"
       WHERE "batch_id" = ${batchId}::uuid
    ORDER BY "position"
    `);

    const pages = await tx.execute<{
      id: string;
      file_id: string;
      file_position: number;
      page_number: number;
      mime_type: ImportPageSummary['mimeType'];
      document_id: string | null;
      excluded_at: string | Date | null;
      excluded_reason: string | null;
    }>(sql`
      SELECT p."id", p."file_id", f."position" AS file_position, p."page_number", p."mime_type",
             p."document_id", p."excluded_at", p."excluded_reason"
        FROM "import_page" p
        JOIN "import_file" f ON f."id" = p."file_id"
       WHERE p."batch_id" = ${batchId}::uuid
    ORDER BY f."position", p."page_number"
    `);

    // The current version of each document made here; a correction keeps the batch.
    const documents = await tx.execute<{
      id: string;
      doc_type: ImportBatchDocument['docType'];
      title: string | null;
      report_date: string;
      version_status: ImportBatchDocument['versionStatus'];
      page_count: number;
    }>(sql`
      SELECT d."id", d."doc_type", d."title", to_char(d."report_date", 'YYYY-MM-DD') AS report_date,
             d."version_status",
             (SELECT count(*) FROM "document_file" df WHERE df."document_id" = d."id")::int AS page_count
        FROM "document_reference" d
       WHERE d."import_batch_id" = ${batchId}::uuid AND d."version_status" <> 'superseded'
    ORDER BY d."recorded_at"
    `);

    const item = this.toListItem(batch);

    return {
      ...item,
      files: [...files].map((file) => ({
        id: file.id,
        position: file.position,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        uploadConfirmed: file.upload_confirmed,
        abandoned: file.abandoned,
        scanStatus: file.scan_status,
        pageCount: file.page_count,
        pagesReady: file.pages_ready,
      })),
      pages: [...pages].map((page) => ({
        id: page.id,
        fileId: page.file_id,
        filePosition: page.file_position,
        pageNumber: page.page_number,
        mimeType: page.mime_type,
        state: page.document_id ? 'classified' : page.excluded_at ? 'excluded' : 'unassigned',
        documentId: page.document_id,
        excludedReason: page.excluded_reason,
      })),
      documents: [...documents].map((document) => ({
        id: document.id,
        docType: document.doc_type,
        title: document.title,
        reportDate: document.report_date,
        pageCount: document.page_count,
        versionStatus: document.version_status,
      })),
      // An empty import has nothing to finish.
      canFinish:
        batch.status !== 'done' &&
        item.progress.files > 0 &&
        item.progress.filesInProgress === 0 &&
        item.progress.unassigned === 0,
    };
  }

  private toListItem(row: BatchRow): ImportBatchListItem {
    return {
      id: row.id,
      patientId: row.patient_id,
      status: row.status,
      note: row.note,
      openedBy: { id: row.opened_by_staff_id, name: row.opened_by_name },
      createdAt: toIso(row.created_at),
      closedAt: row.closed_at ? toIso(row.closed_at) : null,
      progress: {
        files: row.files,
        filesInProgress: row.files_in_progress,
        filesQuarantined: row.files_quarantined,
        pages: row.pages,
        classified: row.classified,
        excluded: row.excluded,
        unassigned: row.pages - row.classified - row.excluded,
      },
    };
  }

  private translate(error: unknown): unknown {
    switch (violatedConstraint(error)) {
      case 'document_reference_ordering_clinician_same_hospital_fk':
      case 'document_reference_ordering_clinician_is_clinician':
        return new BadRequestException(
          'The ordering clinician must be a clinician at your hospital',
        );
      case 'document_reference_report_date_plausible':
        return new BadRequestException('The report date is not plausible');
      case 'import_page_batch_open':
        return new ConflictException('This import is finished');
      default:
        return error;
    }
  }
}
