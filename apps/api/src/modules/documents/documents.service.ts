import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  hasPermission,
  type CorrectDocumentInput,
  type CreateDocumentInput,
  type CreatedDocument,
  type DocumentAvailability,
  type DocumentFileUrl,
  type DocumentList,
  type DocumentSummary,
  type ListDocumentsQuery,
} from '@health24/shared';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { documentFiles, documentReferences } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  coveringConsentId,
  istToday,
  requireLinkedPatient,
  toIso,
  violatedConstraint,
} from '../clinical/clinical-access';
import { ScanQueue } from '../scanning/scan-queue';
import { documentFileKey } from '../storage/keys';
import { StorageService } from '../storage/storage.service';

type FileRow = DocumentSummary['files'][number] & { storageKey: string };

type DocumentRow = {
  id: string;
  patient_id: string;
  hospital_id: string;
  hospital_name: string | null;
  encounter_id: string | null;
  import_batch_id: string | null;
  doc_type: DocumentSummary['docType'];
  title: string | null;
  report_date: string;
  performing_facility: string | null;
  ordering_clinician_id: string | null;
  ordering_clinician_account_name: string | null;
  ordering_clinician_name: string | null;
  availability: DocumentAvailability;
  upload_confirmed_at: string | Date | null;
  recorded_by_staff_id: string;
  recorded_by_name: string | null;
  recorded_at: string | Date;
  version_status: DocumentSummary['versionStatus'];
  supersedes_id: string | null;
  files: FileRow[];
};

/** An upload never confirmed within this long is abandoned and its objects removed. */
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

const DOCUMENT_SELECT = sql`
  SELECT d."id", d."patient_id", d."hospital_id", hd."name" AS hospital_name,
         d."encounter_id", d."import_batch_id", d."doc_type", d."title",
         to_char(d."report_date", 'YYYY-MM-DD') AS report_date, d."performing_facility",
         d."ordering_clinician_id", oc."name" AS ordering_clinician_account_name,
         d."ordering_clinician_name", d."availability", d."upload_confirmed_at",
         d."recorded_by_staff_id", rb."name" AS recorded_by_name, d."recorded_at",
         d."version_status", d."supersedes_id",
         coalesce((
           SELECT json_agg(json_build_object(
                    'id', f."id", 'position', f."position", 'mimeType', f."mime_type",
                    'sizeBytes', f."size_bytes", 'scanStatus', f."scan_status",
                    'pageCount', f."page_count", 'storageKey', f."storage_key")
                  ORDER BY f."position")
             FROM "document_file" f
            WHERE f."document_id" = d."id"
         ), '[]'::json) AS files
    FROM "document_reference" d
    LEFT JOIN "hospital_directory" hd ON hd."id" = d."hospital_id"
    LEFT JOIN "staff_user" oc ON oc."id" = d."ordering_clinician_id"
    LEFT JOIN "staff_user" rb ON rb."id" = d."recorded_by_staff_id"
`;

/**
 * Documents (sp4-plan.md, Phase 3).
 *
 * The API issues presigned URLs and records what happened; it never carries a
 * file's bytes. Row-level security decides which hospital sees which document
 * (its own, or another's under consent for `documents`). On top of that, the
 * front desk works only with its own hospital's uploads and never opens one
 * (Decision H1).
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly scans: ScanQueue,
  ) {}

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  async create(
    actor: Actor,
    input: CreateDocumentInput,
    meta: RequestMeta,
  ): Promise<CreatedDocument> {
    const hospitalId = requireHospital(actor);
    const patientId = input.patientId.toLowerCase();
    this.refuseFutureDate(input.reportDate);

    const documentId = uuidv7();
    const files = input.files.map((file, index) => {
      const fileId = uuidv7();
      return {
        id: fileId,
        position: index + 1,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        storageKey: documentFileKey({ hospitalId, patientId, documentId, fileId }),
      };
    });

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);
      if (input.encounterId)
        await this.requireEncounter(tx, hospitalId, patientId, input.encounterId);

      try {
        await tx.insert(documentReferences).values({
          id: documentId,
          patientId,
          hospitalId,
          encounterId: input.encounterId ?? null,
          docType: input.docType,
          title: input.title ?? null,
          reportDate: input.reportDate,
          performingFacility: input.performingFacility ?? null,
          orderingClinicianId: input.orderingClinicianId ?? null,
          orderingClinicianName: input.orderingClinicianName ?? null,
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
          })),
        );
      } catch (error) {
        throw this.translate(error);
      }

      return this.load(tx, documentId);
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
      resourceType: 'document_reference',
      resourceId: documentId,
      patientId,
      action: 'create',
      meta,
    });

    return { document: this.toSummary(row!, hospitalId), uploads };
  }

  /**
   * The uploader says every file has arrived. Each is checked against what was
   * declared, then queued for scanning. Safe to repeat while the scan is
   * pending: a file already scanned is not scanned again.
   */
  async complete(actor: Actor, documentId: string, meta: RequestMeta): Promise<DocumentSummary> {
    const hospitalId = requireHospital(actor);

    const document = await this.db.asTenant(hospitalId, (tx) => this.load(tx, documentId));
    if (!document || document.hospital_id !== hospitalId) {
      throw new NotFoundException('Document not found');
    }

    if (document.version_status !== 'current' || document.availability !== 'pending_scan') {
      throw new ConflictException(
        `This document is already ${document.availability.replace('_', ' ')}`,
      );
    }

    const problems: string[] = [];

    for (const file of document.files) {
      const stored = await this.storage.describe(file.storageKey);

      if (!stored) {
        problems.push(`File ${file.position} has not been uploaded`);
      } else if (stored.size !== file.sizeBytes || stored.contentType !== file.mimeType) {
        problems.push(`File ${file.position} does not match what was declared`);
      }
    }

    if (problems.length > 0) {
      throw new ConflictException(problems.join('; '));
    }

    // Queued before the confirmation is recorded: a scan that runs for an
    // unconfirmed upload does no harm, but a confirmed upload never scanned
    // would wait forever.
    for (const file of document.files) {
      if (file.scanStatus === 'pending') await this.scans.enqueue(file.storageKey);
    }

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      await tx.execute(sql`
        UPDATE "document_reference" SET "upload_confirmed_at" = now()
         WHERE "id" = ${documentId} AND "upload_confirmed_at" IS NULL
      `);
      return this.load(tx, documentId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'document_reference',
      resourceId: documentId,
      patientId: document.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row!, hospitalId);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async list(
    actor: Actor,
    patientId: string,
    query: ListDocumentsQuery,
    meta: RequestMeta,
  ): Promise<DocumentList> {
    const hospitalId = requireHospital(actor);
    // The front desk sees what its own hospital uploaded, never another's (Decision H1).
    const ownOnly = query.scope === 'own' || !hasPermission(actor.role, 'clinical:read');

    const filters: SQL[] = [
      sql`d."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))`,
      sql`d."version_status" = 'current'`,
    ];

    if (query.types?.length) {
      filters.push(
        sql`d."doc_type"::text IN (${sql.join(
          query.types.map((type) => sql`${type}`),
          sql`, `,
        )})`,
      );
    }
    if (query.from) filters.push(sql`d."report_date" >= ${query.from}::date`);
    if (query.to) filters.push(sql`d."report_date" <= ${query.to}::date`);
    if (ownOnly) filters.push(sql`d."hospital_id" = ${hospitalId}::uuid`);

    const where = sql.join(filters, sql` AND `);
    const offset = (query.page - 1) * query.limit;

    const { rows, total, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await tx.execute<DocumentRow>(sql`
        ${DOCUMENT_SELECT}
         WHERE ${where}
      ORDER BY d."report_date" DESC, d."recorded_at" DESC
         LIMIT ${query.limit} OFFSET ${offset}
      `);

      const [count] = await tx.execute<{ total: number }>(sql`
        SELECT count(*)::int AS total FROM "document_reference" d WHERE ${where}
      `);

      return {
        rows: [...found],
        total: count?.total ?? 0,
        consentArtefactId: ownOnly ? null : await coveringConsentId(tx, patientId, 'documents'),
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'document_reference',
      patientId,
      action: 'search',
      consentArtefactId: rows.some((row) => row.hospital_id !== hospitalId)
        ? consentArtefactId
        : null,
      meta,
    });

    return {
      results: rows.map((row) => this.toSummary(row, hospitalId)),
      total,
      sharedFromOtherHospitals: consentArtefactId !== null,
    };
  }

  async get(actor: Actor, documentId: string, meta: RequestMeta): Promise<DocumentSummary> {
    const hospitalId = requireHospital(actor);

    const { row, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await this.visibleTo(tx, actor, hospitalId, documentId);
      return {
        row: found,
        consentArtefactId:
          found.hospital_id === hospitalId
            ? null
            : await coveringConsentId(tx, found.patient_id, 'documents'),
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'document_reference',
      resourceId: documentId,
      patientId: row.patient_id,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  /**
   * A presigned link to one file, valid for about a minute, for roles that
   * read clinical records. Every link issued is an audit entry: a view as a
   * read, a download as an export.
   */
  async fileUrl(
    actor: Actor,
    documentId: string,
    fileId: string,
    disposition: 'inline' | 'attachment',
    meta: RequestMeta,
  ): Promise<DocumentFileUrl> {
    const hospitalId = requireHospital(actor);

    const { row, file, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await this.visibleTo(tx, actor, hospitalId, documentId);

      if (found.version_status === 'entered_in_error') {
        throw new NotFoundException('Document not found');
      }

      const match = found.files.find((candidate) => candidate.id === fileId);
      if (!match) throw new NotFoundException('File not found');

      return {
        row: found,
        file: match,
        consentArtefactId:
          found.hospital_id === hospitalId
            ? null
            : await coveringConsentId(tx, found.patient_id, 'documents'),
      };
    });

    if (row.availability !== 'available') {
      throw new ConflictException(
        row.availability === 'pending_scan'
          ? 'This document is still being checked for viruses'
          : `This document is ${row.availability} and cannot be opened`,
      );
    }

    const signed = await this.storage.presignDownload({ key: file.storageKey, disposition });

    await this.audit.recordForActor(actor, {
      resourceType: 'document_file',
      resourceId: fileId,
      patientId: row.patient_id,
      action: disposition === 'attachment' ? 'export' : 'read',
      consentArtefactId,
      meta,
    });

    return { ...signed, disposition };
  }

  // ---------------------------------------------------------------------------
  // Corrections
  // ---------------------------------------------------------------------------

  /** Corrects a document's details as a new version that carries the same files. */
  async correct(
    actor: Actor,
    documentId: string,
    input: CorrectDocumentInput,
    meta: RequestMeta,
  ): Promise<DocumentSummary> {
    const hospitalId = requireHospital(actor);
    this.refuseFutureDate(input.reportDate);
    const correctionId = uuidv7();

    const { row, patientId } = await this.db.asTenant(hospitalId, async (tx) => {
      const original = await this.changeableBy(tx, hospitalId, documentId);

      if (original.availability !== 'available') {
        throw new ConflictException('Only a document that passed its scan can be corrected');
      }

      try {
        await this.retire(tx, actor, documentId, 'superseded', input.reason);

        await tx.insert(documentReferences).values({
          id: correctionId,
          patientId: original.patient_id,
          hospitalId,
          encounterId: original.encounter_id,
          importBatchId: original.import_batch_id,
          docType: input.docType,
          title: input.title ?? null,
          reportDate: input.reportDate,
          performingFacility: input.performingFacility ?? null,
          orderingClinicianId: input.orderingClinicianId ?? null,
          orderingClinicianName: input.orderingClinicianName ?? null,
          availability: 'available',
          availabilityChangedAt: sql`now()`,
          uploadConfirmedAt: original.upload_confirmed_at
            ? new Date(original.upload_confirmed_at)
            : null,
          recordedByStaffId: actor.staffUserId,
          supersedesId: documentId,
        });

        // The same stored objects, with the scan results they already have.
        await tx.execute(sql`
          INSERT INTO "document_file"
            ("document_id", "patient_id", "hospital_id", "position", "storage_key", "mime_type",
             "size_bytes", "sha256", "scan_status", "scanned_at", "scan_signature", "page_count",
             "thumbnail_key")
          SELECT ${correctionId}::uuid, f."patient_id", f."hospital_id", f."position", f."storage_key",
                 f."mime_type", f."size_bytes", f."sha256", f."scan_status", f."scanned_at",
                 f."scan_signature", f."page_count", f."thumbnail_key"
            FROM "document_file" f
           WHERE f."document_id" = ${documentId}::uuid
        `);
      } catch (error) {
        throw this.translate(error);
      }

      return { row: await this.load(tx, correctionId), patientId: original.patient_id };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'document_reference',
      resourceId: correctionId,
      patientId,
      action: 'update',
      meta,
    });

    return this.toSummary(row!, hospitalId);
  }

  /** A wrong upload: hidden from lists and never served, but kept. */
  async markEnteredInError(
    actor: Actor,
    documentId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<DocumentSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      await this.changeableBy(tx, hospitalId, documentId);
      await this.retire(tx, actor, documentId, 'entered_in_error', reason);
      return this.load(tx, documentId);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'document_reference',
      resourceId: documentId,
      patientId: row!.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row!, hospitalId);
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  /**
   * Marks uploads never confirmed within a day as abandoned and removes what
   * reached storage. Never part of the record, so not subject to the
   * never-delete rule. Run per hospital, under each hospital's own context.
   */
  async abandonStale(olderThanMs = ABANDON_AFTER_MS): Promise<number> {
    const hospitals = await this.db.raw.execute<{ id: string }>(
      sql`SELECT "id" FROM "hospital_directory"`,
    );
    let abandoned = 0;

    for (const { id: hospitalId } of hospitals) {
      const stale = await this.db.asTenant(hospitalId, async (tx) => {
        const found = await tx.execute<{ id: string; keys: string[] }>(sql`
          SELECT d."id",
                 array(SELECT f."storage_key" FROM "document_file" f WHERE f."document_id" = d."id") AS keys
            FROM "document_reference" d
           WHERE d."hospital_id" = ${hospitalId}::uuid
             AND d."availability" = 'pending_scan'
             AND d."upload_confirmed_at" IS NULL
             AND d."recorded_at" < now() - make_interval(secs => ${olderThanMs / 1000})
        `);
        return [...found];
      });

      for (const document of stale) {
        for (const key of document.keys) await this.storage.remove(key);

        await this.db.asTenant(hospitalId, (tx) =>
          tx.execute(sql`
            UPDATE "document_reference"
               SET "availability" = 'abandoned', "availability_changed_at" = now()
             WHERE "id" = ${document.id} AND "availability" = 'pending_scan'
          `),
        );

        abandoned += 1;
      }
    }

    if (abandoned > 0) this.logger.log(`Abandoned ${abandoned} upload(s) never completed`);
    return abandoned;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async load(tx: DbTransaction, documentId: string): Promise<DocumentRow | null> {
    const [row] = await tx.execute<DocumentRow>(sql`
      ${DOCUMENT_SELECT}
       WHERE d."id" = ${documentId}::uuid
    `);
    return row ?? null;
  }

  /** Visible under row-level security — and, for the front desk, its own hospital's only. */
  private async visibleTo(
    tx: DbTransaction,
    actor: Actor,
    hospitalId: string,
    documentId: string,
  ): Promise<DocumentRow> {
    const row = await this.load(tx, documentId);
    const readsClinical = hasPermission(actor.role, 'clinical:read');

    if (!row || (!readsClinical && row.hospital_id !== hospitalId)) {
      throw new NotFoundException('Document not found');
    }

    return row;
  }

  /** The current version of one of this hospital's own documents. */
  private async changeableBy(
    tx: DbTransaction,
    hospitalId: string,
    documentId: string,
  ): Promise<DocumentRow> {
    const row = await this.load(tx, documentId);

    if (!row) throw new NotFoundException('Document not found');
    if (row.hospital_id !== hospitalId) {
      throw new ForbiddenException('Only the hospital that holds a document can change it');
    }
    if (row.version_status !== 'current') {
      throw new ConflictException('This version has already been corrected or withdrawn');
    }

    return row;
  }

  private async retire(
    tx: DbTransaction,
    actor: Actor,
    documentId: string,
    status: 'superseded' | 'entered_in_error',
    reason: string,
  ): Promise<void> {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE "document_reference"
         SET "version_status" = ${status}::version_status, "status_changed_at" = now(),
             "status_changed_by_staff_id" = ${actor.staffUserId}, "status_reason" = ${reason}
       WHERE "id" = ${documentId}::uuid AND "version_status" = 'current'
   RETURNING "id"
    `);

    if ([...updated].length === 0) {
      throw new ConflictException('This document was changed by someone else a moment ago');
    }
  }

  private async requireEncounter(
    tx: DbTransaction,
    hospitalId: string,
    patientId: string,
    encounterId: string,
  ): Promise<void> {
    const [found] = await tx.execute<{ id: string }>(sql`
      SELECT "id" FROM "encounter"
       WHERE "id" = ${encounterId}::uuid AND "hospital_id" = ${hospitalId}::uuid
         AND "patient_id" = ${patientId}::uuid AND "status" <> 'cancelled'
    `);

    if (!found) {
      throw new BadRequestException(
        'A document is filed under one of your hospital’s open or finished visits for this patient',
      );
    }
  }

  private refuseFutureDate(reportDate: string): void {
    if (reportDate > istToday()) {
      throw new BadRequestException('The report date cannot be in the future');
    }
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
      default:
        return error;
    }
  }

  private toSummary(row: DocumentRow, hospitalId: string): DocumentSummary {
    return {
      id: row.id,
      patientId: row.patient_id,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      encounterId: row.encounter_id,
      importBatchId: row.import_batch_id,
      docType: row.doc_type,
      title: row.title,
      reportDate: row.report_date,
      performingFacility: row.performing_facility,
      orderingClinician: row.ordering_clinician_id
        ? {
            id: row.ordering_clinician_id,
            name: row.ordering_clinician_account_name,
            external: false,
          }
        : row.ordering_clinician_name
          ? { id: null, name: row.ordering_clinician_name, external: true }
          : null,
      availability: row.availability,
      // Storage keys stay on the server.
      files: row.files.map(({ storageKey: _key, ...file }) => file),
      recordedBy: { id: row.recorded_by_staff_id, name: row.recorded_by_name },
      recordedAt: toIso(row.recorded_at),
      versionStatus: row.version_status,
      supersedesId: row.supersedes_id,
    };
  }
}
