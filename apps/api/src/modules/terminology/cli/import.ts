import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conceptMapReleaseSchema, terminologyReleaseSchema } from '@health24/shared';
import { loadEnv } from '../../../config/load-env';
import { createDb } from '../../../db/client';
import {
  activateCodeSystem,
  importCodeSystemRelease,
  importConceptMapRelease,
  ReleaseImportError,
} from '../terminology-import';

loadEnv();

/**
 * Imports terminology releases from files in the canonical format.
 *
 *   pnpm terminology:import <file...> [--activate] [--by "Name"]
 *
 * Files are processed in the order given and the run stops at the first
 * failure, because a concept map depends on the code systems before it.
 * `--activate` makes each imported code system the active version of its key.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const activate = args.includes('--activate');
  const byIndex = args.indexOf('--by');
  const importedBy =
    byIndex >= 0 && args[byIndex + 1] ? args[byIndex + 1]! : `cli:${os.userInfo().username}`;

  const files = args.filter(
    (arg, index) => !arg.startsWith('--') && !(byIndex >= 0 && index === byIndex + 1),
  );

  if (files.length === 0) {
    console.error('Usage: terminology:import <file...> [--activate] [--by "Name"]');
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set');

  const handle = createDb(url, { max: 1 });

  try {
    for (const file of files) {
      const absolute = path.resolve(file);
      let raw: unknown;

      try {
        raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      } catch (error) {
        throw new ReleaseImportError(
          `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const isMap = typeof raw === 'object' && raw !== null && 'map' in raw;
      const parsed = isMap
        ? conceptMapReleaseSchema.safeParse(raw)
        : terminologyReleaseSchema.safeParse(raw);

      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 20)
          .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n');

        throw new ReleaseImportError(`${file} is not a valid release:\n${issues}`);
      }

      const experimental = isMap
        ? (parsed.data as { map: { experimental: boolean } }).map.experimental
        : (parsed.data as { codeSystem: { experimental: boolean } }).codeSystem.experimental;

      if (experimental && process.env.NODE_ENV === 'production') {
        throw new ReleaseImportError(
          `${file} is experimental and cannot be imported into production`,
        );
      }

      const outcome = isMap
        ? await importConceptMapRelease(handle.db, conceptMapReleaseSchema.parse(raw), importedBy)
        : await importCodeSystemRelease(handle.db, terminologyReleaseSchema.parse(raw), importedBy);

      const counts = Object.entries(outcome.counts)
        .map(([name, count]) => `${count} ${name}`)
        .join(', ');

      console.log(
        `${outcome.result.padEnd(9)} ${outcome.kind === 'concept_map' ? 'map ' : ''}${outcome.key} ${outcome.version}` +
          (counts ? ` (${counts})` : ''),
      );

      if (activate && outcome.kind === 'code_system') {
        const changed = await activateCodeSystem(handle.db, outcome.id, null);
        console.log(
          `${changed ? 'activated' : 'already active'} ${outcome.key} ${outcome.version}`,
        );
      }
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ReleaseImportError ? `Import refused: ${error.message}` : error);
  process.exitCode = 1;
});
