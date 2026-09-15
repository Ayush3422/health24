import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { MAX_DOCUMENT_FILE_BYTES } from '@health24/shared';
import { sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { v5 as uuidv5 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import { scanOrRecover } from '../scanning/scan-or-recover';
import type { ScanJobData, ScanJobResult } from '../scanning/scan-queue';
import { ScanProcessor } from '../scanning/scan.processor';
import { importPageKey, parseImportFileKey, type ImportFileKeyParts } from '../storage/keys';
import { StorageService } from '../storage/storage.service';

/** Page ids are derived from the file and page number, so a retried job makes the same pages. */
const PAGE_ID_NAMESPACE = '5b0e6f9c-2d4a-4f61-9a3e-7c1d8b2e4f60';

const pageIdFor = (fileId: string, pageNumber: number) =>
  uuidv5(`${fileId}:${pageNumber}`, PAGE_ID_NAMESPACE);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type PlannedPage = {
  id: string;
  pageNumber: number;
  key: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

/**
 * Scans one file of a legacy folder and, once it is clean, cuts it into pages
 * (Decision E1).
 *
 * The original stays as uploaded. An image is one page; a PDF becomes one
 * single-page PDF per page, so a clinician is later shown only the pages
 * classified into a document — never the rest of the folder. A PDF the
 * library cannot read, such as an encrypted one, stays whole as one page.
 */
@Injectable()
export class ImportScanHandler {
  private readonly logger = new Logger(ImportScanHandler.name);

  constructor(
    private readonly processor: ScanProcessor,
    private readonly storage: StorageService,
    private readonly db: DatabaseService,
  ) {}

  async process(data: ScanJobData): Promise<ScanJobResult> {
    const parts = parseImportFileKey(data.key);
    const result = await scanOrRecover(this.processor, this.storage, data);

    await this.db.asTenant(parts.hospitalId, (tx) =>
      tx.execute(sql`
        UPDATE "import_file"
           SET "scan_status" = ${result.outcome}::file_scan_status, "scanned_at" = now(),
               "sha256" = ${result.sha256 || null}, "scan_signature" = ${result.signature ?? null}
         WHERE "storage_key" = ${data.key} AND "scan_status" = 'pending'
      `),
    );

    if (result.outcome === 'infected') {
      this.logger.warn(
        `Quarantined a file of import ${parts.batchId}: ${result.signature ?? 'infected file'}`,
      );
      return result;
    }

    await this.cutPages(parts, data.key);
    return result;
  }

  private async cutPages(parts: ImportFileKeyParts, key: string): Promise<void> {
    const [file] = await this.db.asTenant(parts.hospitalId, (tx) =>
      tx.execute<{
        mime_type: string;
        size_bytes: number;
        sha256: string | null;
        scan_status: string;
        pages_created_at: string | Date | null;
      }>(sql`
        SELECT "mime_type", "size_bytes", "sha256", "scan_status", "pages_created_at"
          FROM "import_file" WHERE "id" = ${parts.fileId}::uuid
      `),
    );

    // Already cut on an earlier attempt, or not clean: nothing to do.
    if (!file || file.scan_status !== 'clean' || file.pages_created_at) return;
    if (!file.sha256) throw new Error(`Import file ${parts.fileId} is clean but has no checksum`);

    const split = file.mime_type === 'application/pdf' ? await this.splitPdf(key) : null;
    const planned: PlannedPage[] = [];

    if (split) {
      for (const [index, bytes] of split.entries()) {
        const id = pageIdFor(parts.fileId, index + 1);
        const pageKey = importPageKey({ ...parts, pageId: id });

        await this.storage.put(pageKey, bytes, 'application/pdf');
        planned.push({
          id,
          pageNumber: index + 1,
          key: pageKey,
          mimeType: 'application/pdf',
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    } else {
      const id = pageIdFor(parts.fileId, 1);
      const pageKey = importPageKey({ ...parts, pageId: id });

      await this.storage.copy(key, pageKey);
      planned.push({
        id,
        pageNumber: 1,
        key: pageKey,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        sha256: file.sha256,
      });
    }

    await this.db.asTenant(parts.hospitalId, async (tx) => {
      for (const page of planned) {
        await tx.execute(sql`
          INSERT INTO "import_page"
            ("id", "batch_id", "file_id", "patient_id", "hospital_id", "page_number",
             "storage_key", "mime_type", "size_bytes", "sha256")
          VALUES (${page.id}, ${parts.batchId}, ${parts.fileId}, ${parts.patientId}, ${parts.hospitalId},
                  ${page.pageNumber}, ${page.key}, ${page.mimeType}, ${page.sizeBytes}, ${page.sha256})
          ON CONFLICT DO NOTHING
        `);
      }

      await tx.execute(sql`
        UPDATE "import_file"
           SET "page_count" = ${split ? split.length : null}, "pages_created_at" = now()
         WHERE "id" = ${parts.fileId}::uuid AND "pages_created_at" IS NULL
      `);
    });
  }

  /** One single-page PDF per page, or null when the file cannot be split. */
  private async splitPdf(key: string): Promise<Uint8Array[] | null> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of await this.storage.read(key)) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }

      const source = await PDFDocument.load(Buffer.concat(chunks), { updateMetadata: false });
      const pages: Uint8Array[] = [];

      for (let index = 0; index < source.getPageCount(); index += 1) {
        const single = await PDFDocument.create({ updateMetadata: false });
        const [copied] = await single.copyPages(source, [index]);
        single.addPage(copied!);

        const bytes = await single.save();
        // A page carrying the whole file's shared images can outgrow the limit: keep it whole.
        if (bytes.byteLength > MAX_DOCUMENT_FILE_BYTES) return null;
        pages.push(bytes);
      }

      return pages.length > 0 ? pages : null;
    } catch (error) {
      this.logger.warn(`Kept an import file whole: it could not be split (${String(error)})`);
      return null;
    }
  }
}
