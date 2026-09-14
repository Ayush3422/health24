import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../src/modules/storage/storage.service';
import { createStorageContext, newFileKey, TEST_BUCKET } from './storage-scanning';

/**
 * Object storage behaves as the documents design depends on (T3): nothing is
 * reachable without a signed URL, a URL stops working when it expires, and an
 * upload URL admits exactly the declared type and length.
 *
 * Runs against the S3-compatible server in Docker Compose, so the signatures
 * are checked by a real implementation of S3's rules rather than a mock.
 */
describe('document storage', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;

  const report = Buffer.from('%PDF-1.4\nSynthetic lab report for storage tests\n%%EOF\n');

  async function upload(key: string, body: Buffer, contentType = 'application/pdf') {
    const signed = await storage.presignUpload({
      key,
      contentType,
      contentLength: body.length,
    });

    return fetch(signed.url, { method: signed.method, headers: signed.headers, body });
  }

  beforeAll(async () => {
    moduleRef = await createStorageContext();
    storage = moduleRef.get(StorageService);
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('accepts an upload of exactly the declared type and length', async () => {
    const key = newFileKey();

    const response = await upload(key, report);

    expect(response.status).toBe(200);
    expect(await storage.describe(key)).toEqual({
      size: report.length,
      contentType: 'application/pdf',
    });
  });

  it('refuses an upload of a different type than was signed', async () => {
    const key = newFileKey();
    const signed = await storage.presignUpload({
      key,
      contentType: 'application/pdf',
      contentLength: report.length,
    });

    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: report,
    });

    expect(response.status).toBe(403);
    expect(await storage.describe(key)).toBeNull();
  });

  it('refuses an upload of a different length than was signed', async () => {
    const key = newFileKey();
    const signed = await storage.presignUpload({
      key,
      contentType: 'application/pdf',
      contentLength: report.length + 1_000,
    });

    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: report,
    });

    expect(response.status).toBe(403);
    expect(await storage.describe(key)).toBeNull();
  });

  it('serves nothing to a request without a signature', async () => {
    const key = newFileKey();
    await upload(key, report);

    const endpoint = process.env.STORAGE_ENDPOINT!.replace(/\/$/, '');
    const response = await fetch(`${endpoint}/${TEST_BUCKET}/${key}`);

    expect([401, 403]).toContain(response.status);
    expect(await response.text()).not.toContain('Synthetic lab report');
  });

  it('serves a file through a short-lived URL, and refuses it once expired', async () => {
    const key = newFileKey();
    await upload(key, report);

    const signed = await storage.presignDownload({
      key,
      disposition: 'inline',
      expiresInSeconds: 2,
    });

    const fresh = await fetch(signed.url);
    expect(fresh.status).toBe(200);
    expect(Buffer.from(await fresh.arrayBuffer()).equals(report)).toBe(true);
    expect(fresh.headers.get('content-disposition')).toBe('inline');
    expect(fresh.headers.get('cache-control')).toBe('private, no-store');

    await new Promise((resolve) => setTimeout(resolve, 3_500));

    const expired = await fetch(signed.url);
    expect(expired.status).toBe(403);
  });

  it('marks a download as an attachment when asked', async () => {
    const key = newFileKey();
    await upload(key, report);

    const signed = await storage.presignDownload({ key, disposition: 'attachment' });
    const response = await fetch(signed.url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment');
  });

  it('moves a file to quarantine, where its old key no longer answers', async () => {
    const key = newFileKey();
    await upload(key, report);

    const quarantined = await storage.quarantine(key);

    expect(await storage.describe(key)).toBeNull();
    expect(await storage.describe(quarantined)).toEqual({
      size: report.length,
      contentType: 'application/pdf',
    });
  });

  it('refuses a key that could carry personal data, before storage is asked', async () => {
    await expect(
      storage.presignUpload({
        key: 'patients/Kamala Devi/lft.pdf',
        contentType: 'application/pdf',
        contentLength: 10,
      }),
    ).rejects.toThrow(/identifiers alone/);
  });
});
