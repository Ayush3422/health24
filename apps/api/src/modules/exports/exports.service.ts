import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DataExportSummary, ExportDownload, ExportFormat } from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { dataExports } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../clinical/clinical-access';
import { StorageService } from '../storage/storage.service';
import { ExportQueue } from './export-queue';

/** How long a download link lasts: long enough to save a large file, short enough to be useless later. */
const LINK_SECONDS = 60 * 60;

/** How many past exports the portal lists. */
const SHOWN = 10;

type ExportRow = {
  id: string;
  status: DataExportSummary['status'];
  requested_at: string | Date;
  ready_at: string | Date | null;
  expires_at: string | Date | null;
  entry_count: number | null;
  failure_reason: string | null;
  pdf_key: string | null;
  fhir_key: string | null;
};

/**
 * The patient's copy of their own record, asked for in the portal (SP5,
 * Decision N1). The request is recorded and queued; the worker builds it; the
 * patient downloads it through links issued one at a time and audited as
 * exports.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly queue: ExportQueue,
  ) {}

  async request(patient: PatientActor, meta: RequestMeta): Promise<DataExportSummary> {
    const row = await this.db.asPatient(patient.patientId, async (tx) => {
      const [pending] = await tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "data_export"
         WHERE "patient_id" = ANY (app.patient_record_ids(${patient.patientId}::uuid))
           AND "status" = 'pending'
         LIMIT 1
      `);

      if (pending) {
        throw new ConflictException('Your record is already being prepared');
      }

      const [created] = await tx
        .insert(dataExports)
        .values({ patientId: patient.patientId, requestedByAccountId: patient.accountId })
        .returning({ id: dataExports.id });

      if (!created) throw new Error('Failed to record the request');

      return this.load(tx, created.id);
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'data_export',
      resourceId: row.id,
      action: 'create',
      meta,
    });

    // A queue that cannot be reached never loses the request: the worker's
    // sweep builds exports whose job never ran.
    await this.queue
      .requested(row.id)
      .catch((error: unknown) =>
        this.logger.warn(`Export ${row.id} left to the sweep: ${String(error)}`),
      );

    return this.toSummary(row);
  }

  async list(patient: PatientActor, meta: RequestMeta): Promise<DataExportSummary[]> {
    const rows = await this.db.asPatient(patient.patientId, async (tx) => [
      ...(await tx.execute<ExportRow>(sql`
        ${EXPORT_SELECT}
         WHERE "patient_id" = ANY (app.patient_record_ids(${patient.patientId}::uuid))
      ORDER BY "requested_at" DESC
         LIMIT ${SHOWN}
      `)),
    ]);

    await this.audit.recordForPatient(patient, {
      resourceType: 'data_export',
      action: 'search',
      meta,
    });

    return rows.map((row) => this.toSummary(row));
  }

  /** A link to one file of a ready export, for an hour, audited as an export of the record. */
  async download(
    patient: PatientActor,
    exportId: string,
    format: ExportFormat,
    meta: RequestMeta,
  ): Promise<ExportDownload> {
    const row = await this.db.asPatient(patient.patientId, (tx) => this.load(tx, exportId));

    if (row.status === 'expired') {
      throw new ConflictException('This copy has expired. Ask for a new one.');
    }
    if (row.status !== 'ready' || !row.pdf_key || !row.fhir_key) {
      throw new ConflictException('Your record is still being prepared');
    }

    const signed = await this.storage.presignDownload({
      key: format === 'pdf' ? row.pdf_key : row.fhir_key,
      disposition: 'attachment',
      expiresInSeconds: LINK_SECONDS,
    });

    await this.audit.recordForPatient(patient, {
      resourceType: 'data_export',
      resourceId: exportId,
      action: 'export',
      meta,
    });

    return { url: signed.url, expiresAt: signed.expiresAt, format };
  }

  private async load(tx: DbTransaction, exportId: string): Promise<ExportRow> {
    const [row] = await tx.execute<ExportRow>(sql`
      ${EXPORT_SELECT} WHERE "id" = ${exportId}::uuid
    `);

    if (!row) throw new NotFoundException('Export not found');

    return row;
  }

  private toSummary(row: ExportRow): DataExportSummary {
    return {
      id: row.id,
      status: row.status,
      requestedAt: toIso(row.requested_at),
      readyAt: row.ready_at ? toIso(row.ready_at) : null,
      expiresAt: row.expires_at ? toIso(row.expires_at) : null,
      entryCount: row.entry_count,
      failureReason: row.failure_reason,
    };
  }
}

const EXPORT_SELECT = sql`
  SELECT "id", "status", "requested_at", "ready_at", "expires_at", "entry_count",
         "failure_reason", "pdf_key", "fhir_key"
    FROM "data_export"
`;
