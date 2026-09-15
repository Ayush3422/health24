import { quarantineKeyFor } from '../storage/keys';
import type { StorageService } from '../storage/storage.service';
import type { ScanJobData, ScanJobResult } from './scan-queue';
import type { ScanProcessor } from './scan.processor';

/**
 * Scans one stored file. A retry after the file was quarantined but before
 * the verdict was saved finds no object to scan: the quarantined copy is the
 * verdict.
 */
export async function scanOrRecover(
  processor: ScanProcessor,
  storage: StorageService,
  data: ScanJobData,
): Promise<ScanJobResult> {
  if (!(await storage.describe(data.key))) {
    const quarantineKey = quarantineKeyFor(data.key);

    if (await storage.describe(quarantineKey)) {
      return {
        key: data.key,
        outcome: 'infected',
        signature: 'Quarantined on an earlier attempt',
        quarantineKey,
        sha256: '',
      };
    }
  }

  return processor.process(data);
}
