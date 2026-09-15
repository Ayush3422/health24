import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { scanStream, type ClamdOptions } from './clamd';
import type { ScanJobData, ScanJobResult } from './scan-queue';

/**
 * Scans one stored file and quarantines it when infected (sp4-plan.md, DF2).
 *
 * A scanner error throws, and the job is retried: the file stays unscanned —
 * and therefore unserved — rather than being passed as clean. Recording the
 * verdict against the document arrives with the document model in Phase 3.
 */
@Injectable()
export class ScanProcessor {
  private readonly logger = new Logger(ScanProcessor.name);
  private readonly clamd: ClamdOptions;

  constructor(
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.clamd = {
      host: config.getOrThrow<string>('CLAMAV_HOST'),
      port: Number(config.getOrThrow<number>('CLAMAV_PORT')),
      timeoutMs: 120_000,
    };
  }

  async process(data: ScanJobData): Promise<ScanJobResult> {
    const object = await this.storage.describe(data.key);

    if (!object) {
      // Nothing to scan will ever appear under this key: do not retry.
      throw new UnrecoverableError('The file to scan does not exist');
    }

    // The checksum of what is actually stored, taken on the way to the scanner.
    const hash = createHash('sha256');
    const source = await this.storage.read(data.key);
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    source.on('error', (error) => hashing.destroy(error));

    const verdict = await scanStream(source.pipe(hashing), this.clamd);
    const sha256 = hash.digest('hex');

    if (verdict.clean) {
      return { key: data.key, outcome: 'clean', sha256 };
    }

    const quarantineKey = await this.storage.quarantine(data.key);
    this.logger.warn(`Quarantined an infected upload (${verdict.signature}): ${data.key}`);

    return {
      key: data.key,
      outcome: 'infected',
      signature: verdict.signature,
      quarantineKey,
      sha256,
    };
  }
}
