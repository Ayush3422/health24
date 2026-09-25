import type { Readable } from 'node:stream';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertStorageKey, quarantineKeyFor } from './keys';

/** Long enough to start an upload on a slow connection; short enough to be useless if leaked. */
export const UPLOAD_URL_TTL_SECONDS = 300;
/** A view or download starts at once; the link has no reason to outlive that. */
export const DOWNLOAD_URL_TTL_SECONDS = 60;

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the browser must send. The body's length is bound into the signature too. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface PresignedDownload {
  url: string;
  expiresAt: string;
}

export interface StoredObject {
  size: number;
  contentType: string | null;
}

const isNotFound = (error: unknown) =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 404 ||
    error.name === 'NotFound' ||
    error.name === 'NoSuchKey');

/**
 * Object storage for documents (sp4-plan.md, DF1).
 *
 * The API never carries a file's bytes to or from a browser: it issues
 * presigned URLs, and the browser talks to storage directly. The worker is the
 * only process that reads an object's content, to scan it.
 *
 * S3 in production, in Mumbai; any S3-compatible server locally, reached
 * through STORAGE_ENDPOINT. Nothing here connects until it is used, so the API
 * starts without storage and only the document routes need it.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('STORAGE_ENDPOINT');
    const accessKeyId = config.get<string>('STORAGE_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('STORAGE_SECRET_ACCESS_KEY');

    this.bucket = config.getOrThrow<string>('STORAGE_BUCKET');
    this.client = new S3Client({
      region: config.getOrThrow<string>('STORAGE_REGION'),
      endpoint,
      // A local server serves buckets as paths, not subdomains.
      forcePathStyle: Boolean(endpoint),
      // In production, credentials come from the task's IAM role.
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      // The SDK otherwise adds checksum parameters to presigned URLs that a
      // browser's plain PUT cannot satisfy.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * A URL to upload one file. The content type and the exact length are part
   * of the signature: a different type, or a body of a different size, is
   * refused by storage itself.
   */
  async presignUpload(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload> {
    assertStorageKey(input.key);
    const expiresIn = input.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS;

    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
    );

    return {
      url,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  /** A URL to view or download one file, for about a minute. */
  async presignDownload(input: {
    key: string;
    disposition: 'inline' | 'attachment';
    expiresInSeconds?: number;
  }): Promise<PresignedDownload> {
    assertStorageKey(input.key);
    const expiresIn = input.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS;

    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentDisposition: input.disposition,
        // Not kept by the browser or anything between it and storage.
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn },
    );

    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  /** The object's size and type, or null when there is no such object. */
  async describe(key: string): Promise<StoredObject | null> {
    assertStorageKey(key);

    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: head.ContentLength ?? 0, contentType: head.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** The object's content. For the scanner only: no file's bytes are ever served by the API. */
  async read(key: string): Promise<Readable> {
    assertStorageKey(key);

    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return object.Body as Readable;
  }

  /** Moves an object under the quarantine prefix, where no URL is ever issued. */
  async quarantine(key: string): Promise<string> {
    const destination = quarantineKeyFor(key);

    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destination,
        CopySource: `${this.bucket}/${key}`,
      }),
    );
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));

    return destination;
  }

  /** Copies an object inside storage: its bytes never leave it. */
  async copy(from: string, to: string): Promise<void> {
    assertStorageKey(from);
    assertStorageKey(to);

    await this.client.send(
      new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${from}` }),
    );
  }

  /** Stores bytes the worker produced, such as one page cut from a scanned PDF. */
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertStorageKey(key);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  /**
   * Removes an object. Only for uploads that never became part of the record:
   * a document, once complete, is never deleted.
   */
  async remove(key: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * That storage answers and the bucket is there, for the readiness probe
   * (sp7-plan.md, T8). Throws when it is not, which is the answer.
   */
  async reachable(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /**
   * Creates the bucket when it does not exist. For local development and
   * tests: in production the bucket is infrastructure, with its encryption,
   * versioning and public-access block set there.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
