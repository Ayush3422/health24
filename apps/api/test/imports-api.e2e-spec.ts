import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentScanHandler } from '../src/modules/documents/document-scan.handler';
import { createScanWorker } from '../src/modules/scanning/scan.worker';
import { StorageService } from '../src/modules/storage/storage.service';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';
import { EICAR, TEST_BUCKET, waitForClamd } from './storage-scanning';

type Upload = { fileId: string; url: string; method: string; headers: Record<string, string> };

type Batch = {
  id: string;
  status: string;
  closedAt: string | null;
  canFinish: boolean;
  progress: {
    files: number;
    filesInProgress: number;
    filesQuarantined: number;
    pages: number;
    classified: number;
    excluded: number;
    unassigned: number;
  };
  files: Array<{ id: string; position: number; scanStatus: string; pageCount: number | null }>;
  pages: Array<{
    id: string;
    filePosition: number;
    pageNumber: number;
    mimeType: string;
    state: string;
    documentId: string | null;
    excludedReason: string | null;
  }>;
  documents: Array<{ id: string; docType: string; pageCount: number }>;
};

/**
 * Legacy paper files end to end (SP4 Phase 6, Decision E1): a scanned folder
 * goes to storage, is scanned and cut into pages by the worker, and is
 * classified page by page into documents — or excluded with a reason — until
 * the import is finished.
 */
describe('imports API', { timeout: 180_000 }, () => {
  let ctx: TestContext;
  let worker: Worker;

  let recordsToken: string;
  let clinicianToken: string;
  let frontDeskToken: string;
  let clinicianBToken: string;

  let patientId: string;
  let batchId: string;
  /** Pages of the folder: the PDF's three, then the JPEG. */
  let pages: Batch['pages'];

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('synthetic prescription scan')]);
  let folderPdf: Buffer;

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  async function put(upload: Upload, body: Buffer) {
    const response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    });
    expect(response.status).toBe(200);
  }

  async function upload(id: string, bodies: Array<{ body: Buffer; mimeType: string }>) {
    const added = await post(`/imports/${id}/files`, recordsToken, {
      files: bodies.map(({ body, mimeType }) => ({ mimeType, sizeBytes: body.length })),
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const { uploads } = added.body as { uploads: Upload[] };
    for (const [index, item] of uploads.entries()) await put(item, bodies[index]!.body);

    const completed = await post(`/imports/${id}/files/complete`, recordsToken);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  }

  async function waitForBatch(id: string, ready: (batch: Batch) => boolean): Promise<Batch> {
    const deadline = Date.now() + 90_000;

    while (Date.now() < deadline) {
      const response = await get(`/imports/${id}`, recordsToken);
      if (response.status === 200 && ready(response.body as Batch)) return response.body as Batch;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Import ${id} never became ready`);
  }

  async function openBatch(note?: string): Promise<string> {
    const response = await post('/imports', recordsToken, { patientId, note });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  }

  beforeAll(async () => {
    process.env.STORAGE_BUCKET = TEST_BUCKET;
    process.env.SCAN_QUEUE_NAME = `document-scans-test-${randomUUID()}`;

    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Import Test', mrnPrefix: 'SIM' });
    const b = await seedHospital({
      name: 'City General Import Test',
      mrnPrefix: 'GIM',
      facilityType: 'allopathic',
    });

    recordsToken = await signIn(ctx, a.staff.records as SeededStaff);
    clinicianToken = await signIn(ctx, a.staff.clinician as SeededStaff);
    frontDeskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    clinicianBToken = await signIn(ctx, b.staff.clinician as SeededStaff);

    patientId = (
      await post('/patients', frontDeskToken, {
        name: 'Savitri Oldfile',
        gender: 'female',
        dateOfBirth: '1958-02-11',
        phone: '9820020202',
      })
    ).body.patient.id;

    const pdf = await PDFDocument.create();
    for (let page = 0; page < 3; page += 1) pdf.addPage();
    folderPdf = Buffer.from(await pdf.save());

    await ctx.app.get(StorageService).ensureBucket();
    await waitForClamd();

    worker = createScanWorker({
      processor: ctx.app.get(DocumentScanHandler),
      redisUrl: process.env.REDIS_URL!,
      queueName: process.env.SCAN_QUEUE_NAME,
    });
  }, 360_000);

  afterAll(async () => {
    await worker?.close();
    await ctx?.close();
  });

  it('opens an import for records staff, and never for the front desk', async () => {
    batchId = await openBatch('OPD folder, 2014–2019');

    const opened = await get(`/imports/${batchId}`, recordsToken);
    // Nothing to finish until the folder is uploaded.
    expect(opened.body).toMatchObject({ status: 'open', note: 'OPD folder, 2014–2019', canFinish: false });
    const empty = await post(`/imports/${batchId}/finish`, recordsToken);
    expect(empty.status).toBe(409);
    expect(empty.body.message).toMatch(/Upload the folder/);

    expect((await post('/imports', frontDeskToken, { patientId })).status).toBe(403);
    expect((await get(`/imports/${batchId}`, frontDeskToken)).status).toBe(403);
  });

  it('scans a folder and cuts it into pages: one per PDF page, one per image', async () => {
    await upload(batchId, [
      { body: folderPdf, mimeType: 'application/pdf' },
      { body: jpeg, mimeType: 'image/jpeg' },
    ]);

    const batch = await waitForBatch(
      batchId,
      (current) => current.progress.filesInProgress === 0 && current.progress.pages === 4,
    );

    expect(batch.files.map((file) => [file.position, file.scanStatus, file.pageCount])).toEqual([
      [1, 'clean', 3],
      [2, 'clean', null],
    ]);
    expect(
      batch.pages.map((page) => [page.filePosition, page.pageNumber, page.mimeType, page.state]),
    ).toEqual([
      [1, 1, 'application/pdf', 'unassigned'],
      [1, 2, 'application/pdf', 'unassigned'],
      [1, 3, 'application/pdf', 'unassigned'],
      [2, 1, 'image/jpeg', 'unassigned'],
    ]);
    expect(batch.canFinish).toBe(false);

    pages = batch.pages;
  });

  it('opens one page at a time through a one-minute link, for its own hospital only', async () => {
    const link = await get(`/imports/${batchId}/pages/${pages[1]!.id}/url`, recordsToken);
    expect(link.status).toBe(200);

    const page = await fetch(link.body.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('application/pdf');

    // A single page cut from the folder, not the folder itself.
    const cut = await PDFDocument.load(new Uint8Array(await page.arrayBuffer()));
    expect(cut.getPageCount()).toBe(1);

    // Every link issued is a read of that page in the audit trail.
    const { client, close } = testDb();
    try {
      const audited = await client<Array<{ action: string }>>`
        SELECT action FROM access_log
         WHERE resource_type = 'import_page' AND resource_id = ${pages[1]!.id}
      `;
      expect(audited.map((row) => row.action)).toEqual(['read']);
    } finally {
      await close();
    }

    expect((await get(`/imports/${batchId}`, clinicianBToken)).status).toBe(404);
    expect((await get(`/imports/${batchId}/pages/${pages[1]!.id}/url`, clinicianBToken)).status).toBe(
      404,
    );
  });

  it('makes a document from pages in the order given, available at once among the patient’s documents', async () => {
    const response = await post(`/imports/${batchId}/documents`, recordsToken, {
      pageIds: [pages[2]!.id, pages[0]!.id],
      docType: 'discharge_summary',
      reportDate: '2016-04-02',
      performingFacility: 'Civil Hospital, Pune',
      orderingClinicianName: 'Dr. R. Kulkarni',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const batch = response.body as Batch;
    expect(batch.status).toBe('classifying');
    expect(batch.documents).toEqual([
      expect.objectContaining({ docType: 'discharge_summary', pageCount: 2 }),
    ]);
    expect(batch.pages.map((page) => page.state)).toEqual([
      'classified',
      'unassigned',
      'classified',
      'unassigned',
    ]);

    const listed = await get(`/patients/${patientId}/documents`, clinicianToken);
    const document = (
      listed.body.results as Array<{ id: string; files: Array<{ id: string }> }>
    ).find((candidate) => candidate.id === batch.documents[0]!.id)!;

    expect(document).toMatchObject({
      importBatchId: batchId,
      availability: 'available',
      reportDate: '2016-04-02',
      orderingClinician: { id: null, name: 'Dr. R. Kulkarni', external: true },
    });
    expect(document.files).toHaveLength(2);

    const file = await get(
      `/documents/${document.id}/files/${document.files[0]!.id}/url`,
      clinicianToken,
    );
    expect(file.status).toBe(200);
    expect((await fetch(file.body.url)).status).toBe(200);
  });

  it('refuses a page already in a document, and a page from another import', async () => {
    const again = await post(`/imports/${batchId}/documents`, recordsToken, {
      pageIds: [pages[0]!.id],
      docType: 'other',
      reportDate: '2016-04-02',
    });
    expect(again.status).toBe(409);

    const other = await openBatch();
    const foreign = await post(`/imports/${other}/documents`, recordsToken, {
      pageIds: [pages[1]!.id],
      docType: 'other',
      reportDate: '2016-04-02',
    });
    expect(foreign.status).toBe(400);
  });

  it('excludes a page with its reason, and keeps it', async () => {
    const response = await post(`/imports/${batchId}/exclusions`, recordsToken, {
      pageIds: [pages[1]!.id],
      reason: 'Another patient’s report filed in this folder',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const excluded = (response.body as Batch).pages[1]!;
    expect(excluded).toMatchObject({
      state: 'excluded',
      excludedReason: 'Another patient’s report filed in this folder',
    });

    expect((await get(`/imports/${batchId}/pages/${excluded.id}/url`, recordsToken)).status).toBe(200);
  });

  it('finishes only once every page is settled, and then takes nothing more', async () => {
    const early = await post(`/imports/${batchId}/finish`, recordsToken);
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/1 page/);

    const prescription = await post(`/imports/${batchId}/documents`, clinicianToken, {
      pageIds: [pages[3]!.id],
      docType: 'prescription',
      reportDate: '2018-11-20',
    });
    expect(prescription.status).toBe(201);

    const finished = await post(`/imports/${batchId}/finish`, recordsToken);
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ status: 'done', canFinish: false });
    expect(finished.body.closedAt).toBeTruthy();

    expect(
      (
        await post(`/imports/${batchId}/files`, recordsToken, {
          files: [{ mimeType: 'image/jpeg', sizeBytes: jpeg.length }],
        })
      ).status,
    ).toBe(409);
    expect((await post(`/imports/${batchId}/finish`, recordsToken)).status).toBe(409);
  });

  it('quarantines an infected folder file and cuts no pages from it', async () => {
    const infected = await openBatch();
    await upload(infected, [{ body: EICAR, mimeType: 'application/pdf' }]);

    const batch = await waitForBatch(
      infected,
      (current) => current.progress.filesQuarantined === 1 && current.progress.filesInProgress === 0,
    );

    expect(batch.files[0]!.scanStatus).toBe('infected');
    expect(batch.pages).toEqual([]);
    expect(batch.canFinish).toBe(true);
  });

  it('lists a patient’s imports for the hospital that holds them', async () => {
    const listed = await get(`/patients/${patientId}/imports`, recordsToken);
    expect(listed.status).toBe(200);
    expect(listed.body.batches.map((batch: Batch) => batch.id)).toContain(batchId);
  });

  it('suggests the names this hospital has given doctors without an account', async () => {
    const response = await get('/external-clinicians?q=kulk', frontDeskToken);

    expect(response.status).toBe(200);
    expect(response.body.names).toEqual(['Dr. R. Kulkarni']);
    expect((await get('/external-clinicians?q=kulk', clinicianBToken)).body.names).toEqual([]);
  });
});
