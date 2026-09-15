import { createHash, randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { DocumentScanHandler } from '../src/modules/documents/document-scan.handler';
import { DocumentsService } from '../src/modules/documents/documents.service';
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

/**
 * The documents API end to end (SP4 Phase 3): a report goes from the front
 * desk straight to storage, is scanned by ClamAV through the queue and a
 * worker, becomes available, and is opened through one-minute links —
 * by clinicians and records staff, under consent at another hospital, and
 * never by the front desk.
 */
describe('documents API', { timeout: 120_000 }, () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let worker: Worker;

  let hospitalA: string;
  let clinicianA: SeededStaff;
  let frontDeskA: SeededStaff;
  let recordsA: SeededStaff;
  let clinicianB: SeededStaff;
  let clinicianToken: string;
  let frontDeskToken: string;
  let recordsToken: string;
  let clinicianBToken: string;
  let frontDeskBToken: string;

  let patientId: string;
  let patientOnlyAtA: string;
  let encounterOther: string;

  /** The lab report uploaded in the first test, scanned clean. */
  let reportId: string;
  let reportFileIds: string[];

  const pdf = Buffer.from('%PDF-1.4\nSynthetic LFT: ALT 42 U/L, AST 38 U/L\n%%EOF\n');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('synthetic scan page two')]);

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

  async function put(upload: Upload, body: Buffer) {
    const response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    });
    expect(response.status).toBe(200);
  }

  async function createDocument(
    token: string,
    bodies: Array<{ body: Buffer; mimeType: string }>,
    details: Record<string, unknown> = {},
  ) {
    const response = await post('/documents', token, {
      patientId,
      docType: 'lab_report',
      reportDate: '2026-09-01',
      files: bodies.map(({ body, mimeType }) => ({ mimeType, sizeBytes: body.length })),
      ...details,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as { document: { id: string }; uploads: Upload[] };
  }

  async function waitForAvailability(documentId: string, expected: string) {
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      const response = await get(`/documents/${documentId}`, clinicianToken);
      if (response.body.availability === expected) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Document ${documentId} never became ${expected}`);
  }

  beforeAll(async () => {
    process.env.STORAGE_BUCKET = TEST_BUCKET;
    process.env.SCAN_QUEUE_NAME = `document-scans-test-${randomUUID()}`;

    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Upload Test', mrnPrefix: 'SUP' });
    const b = await seedHospital({
      name: 'City General Upload Test',
      mrnPrefix: 'GUP',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    clinicianA = a.staff.clinician as SeededStaff;
    frontDeskA = a.staff.frontDesk as SeededStaff;
    recordsA = a.staff.records as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;

    clinicianToken = await signIn(ctx, clinicianA);
    frontDeskToken = await signIn(ctx, frontDeskA);
    recordsToken = await signIn(ctx, recordsA);
    clinicianBToken = await signIn(ctx, clinicianB);
    frontDeskBToken = await signIn(ctx, b.staff.frontDesk as SeededStaff);

    const register = (name: string, phone: string) =>
      post('/patients', frontDeskToken, {
        name,
        gender: 'female',
        dateOfBirth: '1971-05-05',
        phone,
      });

    patientId = (await register('Kamala Uploads', '9820010101')).body.patient.id;
    patientOnlyAtA = (await register('Radha Elsewhere', '9820010102')).body.patient.id;
    encounterOther = (await post('/encounters', clinicianToken, { patientId: patientOnlyAtA })).body
      .id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
        VALUES (${patientId}, ${b.hospital.id}, 'GUP-000001')
      `;
    });

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
    await closeOwner?.();
    await ctx?.close();
  });

  describe('uploading', () => {
    it('takes a report from the front desk straight to storage, scans it, and makes it available', async () => {
      const created = await createDocument(
        frontDeskToken,
        [
          { body: pdf, mimeType: 'application/pdf' },
          { body: jpeg, mimeType: 'image/jpeg' },
        ],
        { performingFacility: 'Metro Diagnostics', orderingClinicianId: clinicianA.id },
      );

      expect(created.document).toMatchObject({
        availability: 'pending_scan',
        hospital: { id: hospitalA, isOwn: true },
        orderingClinician: { id: clinicianA.id, external: false },
        recordedBy: { id: frontDeskA.id },
      });
      expect(created.uploads.map((upload) => upload.method)).toEqual(['PUT', 'PUT']);
      expect(JSON.stringify(created.document)).not.toContain('storageKey');

      reportId = created.document.id;
      reportFileIds = created.uploads.map((upload) => upload.fileId);

      await put(created.uploads[0]!, pdf);
      await put(created.uploads[1]!, jpeg);

      const completed = await post(`/documents/${reportId}/complete`, frontDeskToken);
      expect(completed.status).toBe(200);
      expect(completed.body.availability).toBe('pending_scan');

      const available = await waitForAvailability(reportId, 'available');
      expect(available.files.map((file: { scanStatus: string }) => file.scanStatus)).toEqual([
        'clean',
        'clean',
      ]);

      const stored = await owner<Array<{ position: number; sha256: string }>>`
        SELECT position, sha256 FROM document_file WHERE document_id = ${reportId} ORDER BY position
      `;
      expect(stored.map((row) => row.sha256)).toEqual([sha256(pdf), sha256(jpeg)]);
    });

    it('refuses to complete before every file has arrived, and accepts once it has', async () => {
      const created = await createDocument(frontDeskToken, [
        { body: pdf, mimeType: 'application/pdf' },
        { body: jpeg, mimeType: 'image/jpeg' },
      ]);
      await put(created.uploads[0]!, pdf);

      const early = await post(`/documents/${created.document.id}/complete`, frontDeskToken);
      expect(early.status).toBe(409);
      expect(early.body.message).toContain('File 2 has not been uploaded');

      await put(created.uploads[1]!, jpeg);
      expect(
        (await post(`/documents/${created.document.id}/complete`, frontDeskToken)).status,
      ).toBe(200);
      await waitForAvailability(created.document.id, 'available');
    });

    it('quarantines a document with an infected file, and never serves it', async () => {
      const created = await createDocument(recordsToken, [{ body: EICAR, mimeType: 'image/png' }]);
      await put(created.uploads[0]!, EICAR);
      expect((await post(`/documents/${created.document.id}/complete`, recordsToken)).status).toBe(
        200,
      );

      const quarantined = await waitForAvailability(created.document.id, 'quarantined');
      expect(quarantined.files[0].scanStatus).toBe('infected');

      const link = await get(
        `/documents/${created.document.id}/files/${created.uploads[0]!.fileId}/url`,
        clinicianToken,
      );
      expect(link.status).toBe(409);

      const [file] = await owner<Array<{ storage_key: string; scan_signature: string }>>`
        SELECT storage_key, scan_signature FROM document_file WHERE id = ${created.uploads[0]!.fileId}
      `;
      expect(file!.scan_signature).toMatch(/eicar/i);
      const storage = ctx.app.get(StorageService);
      expect(await storage.describe(file!.storage_key)).toBeNull();
      expect(await storage.describe(`quarantine/${file!.storage_key}`)).not.toBeNull();
    });

    it('checks what it is told before storage is asked', async () => {
      const file = [{ mimeType: 'application/pdf', sizeBytes: 100 }];
      const base = { patientId, docType: 'lab_report', reportDate: '2026-09-01', files: file };

      const cases: Array<[Record<string, unknown>, number]> = [
        [{ reportDate: '2999-01-01' }, 400],
        [{ files: [{ mimeType: 'text/html', sizeBytes: 100 }] }, 400],
        [{ files: [{ mimeType: 'application/pdf', sizeBytes: 26 * 1024 * 1024 }] }, 400],
        [{ files: Array.from({ length: 21 }, () => file[0]) }, 400],
        [{ orderingClinicianId: clinicianA.id, orderingClinicianName: 'Dr. R. Menon' }, 400],
        [{ orderingClinicianId: recordsA.id }, 400],
        [{ encounterId: encounterOther }, 400],
        [{ patientId: randomUUID() }, 404],
      ];

      for (const [change, status] of cases) {
        const response = await post('/documents', frontDeskToken, { ...base, ...change });
        expect(response.status, JSON.stringify(change)).toBe(status);
      }
    });

    it('abandons an upload never completed within a day, and removes what arrived', async () => {
      const documentId = randomUUID();
      const fileId = randomUUID();
      const key = `hospitals/${hospitalA}/patients/${patientId}/documents/${documentId}/${fileId}`;

      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.system_context', 'on', true)`;
        await tx`
          INSERT INTO document_reference
            (id, patient_id, hospital_id, doc_type, report_date, recorded_by_staff_id, recorded_at)
          VALUES (${documentId}, ${patientId}, ${hospitalA}, 'referral', '2026-08-01',
                  ${frontDeskA.id}, now() - interval '2 days')
        `;
        await tx`
          INSERT INTO document_file
            (id, document_id, patient_id, hospital_id, position, storage_key, mime_type, size_bytes)
          VALUES (${fileId}, ${documentId}, ${patientId}, ${hospitalA}, 1, ${key}, 'application/pdf', ${pdf.length})
        `;
      });

      const storage = ctx.app.get(StorageService);
      const signed = await storage.presignUpload({
        key,
        contentType: 'application/pdf',
        contentLength: pdf.length,
      });
      await put({ fileId, url: signed.url, method: 'PUT', headers: signed.headers }, pdf);

      expect(await ctx.app.get(DocumentsService).abandonStale()).toBeGreaterThanOrEqual(1);

      const [row] = await owner<Array<{ availability: string }>>`
        SELECT availability FROM document_reference WHERE id = ${documentId}
      `;
      expect(row!.availability).toBe('abandoned');
      expect(await storage.describe(key)).toBeNull();

      // The completed report is untouched.
      expect((await get(`/documents/${reportId}`, clinicianToken)).body.availability).toBe(
        'available',
      );
    });
  });

  describe('viewing', () => {
    it('issues a one-minute link to clinicians and records staff, and audits every one', async () => {
      const inline = await get(
        `/documents/${reportId}/files/${reportFileIds[0]}/url`,
        clinicianToken,
      );
      expect(inline.status).toBe(200);
      expect(Date.parse(inline.body.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);

      const opened = await fetch(inline.body.url);
      expect(Buffer.from(await opened.arrayBuffer()).equals(pdf)).toBe(true);
      expect(opened.headers.get('content-disposition')).toBe('inline');

      const download = await get(
        `/documents/${reportId}/files/${reportFileIds[1]}/url?disposition=attachment`,
        recordsToken,
      );
      expect(download.status).toBe(200);
      expect((await fetch(download.body.url)).headers.get('content-disposition')).toBe(
        'attachment',
      );

      const audited = await owner<Array<{ actor: string; action: string; resource: string }>>`
        SELECT actor_id::text AS actor, action, resource_id AS resource
          FROM access_log WHERE resource_type = 'document_file' ORDER BY at
      `;
      expect(audited).toEqual([
        { actor: clinicianA.id, action: 'read', resource: reportFileIds[0] },
        { actor: recordsA.id, action: 'export', resource: reportFileIds[1] },
      ]);
    });

    it('lists the front desk’s uploads for its hospital, but never opens one', async () => {
      const list = await get(`/patients/${patientId}/documents`, frontDeskToken);
      expect(list.status).toBe(200);
      expect(list.body.results.map((document: { id: string }) => document.id)).toContain(reportId);

      const link = await get(
        `/documents/${reportId}/files/${reportFileIds[0]}/url`,
        frontDeskToken,
      );
      expect(link.status).toBe(403);
    });

    it('shows another hospital nothing without consent for documents, and the report under it', async () => {
      expect((await get(`/patients/${patientId}/documents`, clinicianBToken)).body).toMatchObject({
        results: [],
        sharedFromOtherHospitals: false,
      });
      expect((await get(`/documents/${reportId}`, clinicianBToken)).status).toBe(404);

      const labValuesOnly = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['observations'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(labValuesOnly.status).toBe(201);
      expect(
        (await get(`/documents/${reportId}/files/${reportFileIds[0]}/url`, clinicianBToken)).status,
      ).toBe(404);

      const documents = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['documents'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(documents.status).toBe(201);

      const list = await get(`/patients/${patientId}/documents`, clinicianBToken);
      expect(list.body.sharedFromOtherHospitals).toBe(true);
      expect(list.body.results.find((d: { id: string }) => d.id === reportId)).toMatchObject({
        hospital: { isOwn: false, name: 'Sanjeevani Upload Test' },
      });

      const link = await get(
        `/documents/${reportId}/files/${reportFileIds[0]}/url`,
        clinicianBToken,
      );
      expect(link.status).toBe(200);

      const [audited] = await owner<Array<{ consent: string | null }>>`
        SELECT consent_artefact_id::text AS consent FROM access_log
         WHERE actor_id = ${clinicianB.id} AND resource_type = 'document_file'
      `;
      expect(audited?.consent).toBe(documents.body.id);

      // The front desk at the other hospital still sees only its own uploads.
      expect((await get(`/patients/${patientId}/documents`, frontDeskBToken)).body.results).toEqual(
        [],
      );
    });
  });

  describe('listing', () => {
    it('filters by type, report date and hospital', async () => {
      const radiology = await createDocument(
        clinicianToken,
        [{ body: pdf, mimeType: 'application/pdf' }],
        { docType: 'radiology', reportDate: '2026-06-01', title: 'Ultrasound abdomen' },
      );

      const ids = async (query: string, token = clinicianToken) =>
        (await get(`/patients/${patientId}/documents${query}`, token)).body.results.map(
          (document: { id: string }) => document.id,
        );

      expect(await ids('?types=radiology')).toEqual([radiology.document.id]);
      expect(await ids('?to=2026-06-30')).toEqual([radiology.document.id]);
      expect(await ids('?from=2026-07-01')).not.toContain(radiology.document.id);
      expect(await ids('?scope=own', clinicianBToken)).toEqual([]);
    });
  });

  describe('corrections', () => {
    let correctedId: string;

    it('corrects the details as a new version that keeps the scanned files', async () => {
      const response = await post(`/documents/${reportId}/correct`, frontDeskToken, {
        docType: 'lab_report',
        reportDate: '2026-08-31',
        performingFacility: 'Metro Diagnostics',
        orderingClinicianName: 'Dr. R. Menon (visiting)',
        reason: 'Report date typed wrongly',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        supersedesId: reportId,
        reportDate: '2026-08-31',
        availability: 'available',
        orderingClinician: { id: null, name: 'Dr. R. Menon (visiting)', external: true },
      });
      expect(response.body.files).toHaveLength(2);
      correctedId = response.body.id;

      expect((await get(`/documents/${reportId}`, clinicianToken)).body.versionStatus).toBe(
        'superseded',
      );

      const listed = (
        await get(`/patients/${patientId}/documents`, clinicianToken)
      ).body.results.map((document: { id: string }) => document.id);
      expect(listed).toContain(correctedId);
      expect(listed).not.toContain(reportId);

      const fileId = response.body.files[0].id;
      const link = await get(`/documents/${correctedId}/files/${fileId}/url`, clinicianToken);
      expect(Buffer.from(await (await fetch(link.body.url)).arrayBuffer()).equals(pdf)).toBe(true);
    });

    it('lets only the holding hospital change a document, even one it shares', async () => {
      const response = await post(`/documents/${correctedId}/entered-in-error`, clinicianBToken, {
        reason: 'Not ours',
      });
      expect(response.status).toBe(403);
    });

    it('marks a wrong upload entered in error: kept, but no longer listed or served', async () => {
      const response = await post(`/documents/${correctedId}/entered-in-error`, recordsToken, {
        reason: 'Belongs to another patient',
      });
      expect(response.status).toBe(200);
      expect(response.body.versionStatus).toBe('entered_in_error');

      const listed = (
        await get(`/patients/${patientId}/documents`, clinicianToken)
      ).body.results.map((document: { id: string }) => document.id);
      expect(listed).not.toContain(correctedId);

      const fileId = response.body.files[0].id;
      expect(
        (await get(`/documents/${correctedId}/files/${fileId}/url`, clinicianToken)).status,
      ).toBe(404);

      const again = await post(`/documents/${correctedId}/entered-in-error`, recordsToken, {
        reason: 'Belongs to another patient',
      });
      expect(again.status).toBe(409);
    });
  });
});
