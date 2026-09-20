import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../db/database.service';
import { exportFileKey } from '../storage/keys';
import { StorageService } from '../storage/storage.service';
import { countEntries, readExportRecord } from './export-record';
import type { ExportOutcome } from './export-queue';
import { buildRecordFhir } from './record-fhir';
import { buildRecordPdf } from './record-pdf';

/** How long a built export can be downloaded before its files are removed. */
const LIVES_FOR_DAYS = 7;

/** Exports still pending after this have lost their job; the sweep builds them. */
const STUCK_AFTER_MINUTES = 10;

/**
 * Builds a patient's copy of their record in the worker (sp5-plan.md,
 * Decision N1): a readable PDF and a FHIR R4 bundle, stored under keys of the
 * patient's own, downloadable for a week, then removed — a whole record is not
 * left lying in storage.
 *
 * The record is read in the patient's context, so row-level security decides
 * what an export can possibly contain.
 */
@Injectable()
export class ExportBuilder {
  private readonly logger = new Logger(ExportBuilder.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  async build(exportId: string): Promise<ExportOutcome> {
    const claimed = await this.db.asSystem(async (tx) => {
      const [row] = await tx.execute<{ patient_id: string }>(sql`
        SELECT "patient_id" FROM "data_export"
         WHERE "id" = ${exportId}::uuid AND "status" = 'pending'
         FOR UPDATE SKIP LOCKED
      `);

      return row ?? null;
    });

    if (!claimed) return 'skipped';

    try {
      const record = await this.db.asPatient(claimed.patient_id, (tx) =>
        readExportRecord(tx, claimed.patient_id),
      );

      const exportedAt = new Date();
      const pdfKey = exportFileKey({ patientId: claimed.patient_id, exportId, format: 'pdf' });
      const fhirKey = exportFileKey({ patientId: claimed.patient_id, exportId, format: 'fhir' });

      await this.storage.put(pdfKey, await buildRecordPdf(record, exportedAt), 'application/pdf');
      await this.storage.put(
        fhirKey,
        new TextEncoder().encode(JSON.stringify(buildRecordFhir(record, exportedAt), null, 2)),
        'application/fhir+json',
      );

      await this.db.asSystem((tx) =>
        tx.execute(sql`
          UPDATE "data_export"
             SET "status" = 'ready', "pdf_key" = ${pdfKey}, "fhir_key" = ${fhirKey},
                 "entry_count" = ${countEntries(record)}, "ready_at" = now(),
                 "expires_at" = now() + make_interval(days => ${LIVES_FOR_DAYS})
           WHERE "id" = ${exportId}::uuid
        `),
      );

      return 'built';
    } catch (error) {
      this.logger.error(`Export ${exportId} failed: ${String(error)}`);

      await this.db.asSystem((tx) =>
        tx.execute(sql`
          UPDATE "data_export"
             SET "status" = 'failed', "failure_reason" = 'The record could not be prepared'
           WHERE "id" = ${exportId}::uuid AND "status" = 'pending'
        `),
      );

      // The job may retry; a failed row is picked up again by a fresh request.
      throw error;
    }
  }

  /** Exports whose job never ran, and those ready for long enough to be removed. */
  async pending(): Promise<string[]> {
    const rows = await this.db.asSystem((tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT "id" FROM "data_export"
         WHERE "status" = 'pending'
           AND "requested_at" < now() - make_interval(mins => ${STUCK_AFTER_MINUTES})
      ORDER BY "requested_at"
         LIMIT 50
      `),
    );

    return [...rows].map((row) => row.id);
  }

  /** Removes the files of exports past their week and marks them expired. */
  async expireOld(): Promise<number> {
    const due = await this.db.asSystem((tx) =>
      tx.execute<{ id: string; pdf_key: string; fhir_key: string }>(sql`
        SELECT "id", "pdf_key", "fhir_key" FROM "data_export"
         WHERE "status" = 'ready' AND "expires_at" <= now()
         LIMIT 100
      `),
    );

    let expired = 0;

    for (const row of due) {
      // Removing an object twice is harmless; leaving one behind is not.
      await this.storage.remove(row.pdf_key);
      await this.storage.remove(row.fhir_key);

      await this.db.asSystem((tx) =>
        tx.execute(sql`
          UPDATE "data_export" SET "status" = 'expired'
           WHERE "id" = ${row.id}::uuid AND "status" = 'ready'
        `),
      );

      expired += 1;
    }

    return expired;
  }
}
