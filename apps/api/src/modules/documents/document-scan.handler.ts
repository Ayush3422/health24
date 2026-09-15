import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { DatabaseService } from '../../db/database.service';
import type { ScanJobData, ScanJobHandler, ScanJobResult } from '../scanning/scan-queue';
import { ScanProcessor } from '../scanning/scan.processor';
import { parseDocumentFileKey, quarantineKeyFor } from '../storage/keys';
import { StorageService } from '../storage/storage.service';

/**
 * Scans one uploaded file and records the verdict against its document.
 *
 * Runs in the worker, under the hospital named in the storage key — the
 * worker needs no access beyond that hospital's own documents. A document
 * becomes available once every file is clean, and quarantined as soon as one
 * is infected; the document row is locked while deciding, so two files
 * finishing together cannot both miss the other's verdict.
 */
@Injectable()
export class DocumentScanHandler implements ScanJobHandler {
  private readonly logger = new Logger(DocumentScanHandler.name);

  constructor(
    private readonly processor: ScanProcessor,
    private readonly storage: StorageService,
    private readonly db: DatabaseService,
  ) {}

  async process(data: ScanJobData): Promise<ScanJobResult> {
    const { hospitalId } = parseDocumentFileKey(data.key);
    const result = await this.scanOrRecover(data);
    // Counted only once a file is known to be clean: an infected PDF is never parsed.
    const pageCount = result.outcome === 'clean' ? await this.countPages(data.key) : null;

    await this.db.asTenant(hospitalId, async (tx) => {
      const updated = await tx.execute<{ document_id: string }>(sql`
        UPDATE "document_file"
           SET "scan_status" = ${result.outcome}::file_scan_status, "scanned_at" = now(),
               "sha256" = ${result.sha256 || null}, "scan_signature" = ${result.signature ?? null},
               "page_count" = ${pageCount}
         WHERE "storage_key" = ${data.key} AND "scan_status" = 'pending'
     RETURNING "document_id"
      `);

      for (const documentId of new Set([...updated].map((row) => row.document_id))) {
        const [document] = await tx.execute<{ availability: string }>(sql`
          SELECT "availability" FROM "document_reference" WHERE "id" = ${documentId}::uuid FOR UPDATE
        `);

        if (document?.availability !== 'pending_scan') continue;

        const [files] = await tx.execute<{ pending: number; infected: number }>(sql`
          SELECT count(*) FILTER (WHERE "scan_status" = 'pending')::int AS pending,
                 count(*) FILTER (WHERE "scan_status" = 'infected')::int AS infected
            FROM "document_file" WHERE "document_id" = ${documentId}::uuid
        `);

        const next =
          (files?.infected ?? 0) > 0 ? 'quarantined' : files?.pending === 0 ? 'available' : null;

        if (next) {
          await tx.execute(sql`
            UPDATE "document_reference"
               SET "availability" = ${next}::document_availability, "availability_changed_at" = now()
             WHERE "id" = ${documentId}::uuid
          `);

          if (next === 'quarantined') {
            this.logger.warn(
              `Quarantined document ${documentId}: ${result.signature ?? 'infected file'}`,
            );
          }
        }
      }
    });

    return result;
  }

  /** A PDF's page count, for lists. Null for images, and for a PDF the library cannot read. */
  private async countPages(key: string): Promise<number | null> {
    const object = await this.storage.describe(key);
    if (object?.contentType !== 'application/pdf') return null;

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of await this.storage.read(key)) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }

      const pdf = await PDFDocument.load(Buffer.concat(chunks), {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      return pdf.getPageCount();
    } catch {
      // Still a document, and still served; it simply has no page count.
      return null;
    }
  }

  /**
   * A retry after the file was quarantined but before the verdict was saved
   * finds no object to scan. The quarantined copy is the verdict.
   */
  private async scanOrRecover(data: ScanJobData): Promise<ScanJobResult> {
    if (!(await this.storage.describe(data.key))) {
      const quarantineKey = quarantineKeyFor(data.key);

      if (await this.storage.describe(quarantineKey)) {
        return {
          key: data.key,
          outcome: 'infected',
          signature: 'Quarantined on an earlier attempt',
          quarantineKey,
          sha256: '',
        };
      }
    }

    return this.processor.process(data);
  }
}
