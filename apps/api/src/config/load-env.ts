import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Loads the nearest `.env`, searching upward from this file.
 *
 * The monorepo keeps one `.env` at the root, but scripts run from
 * `apps/api`. Rather than depending on the working directory — which differs
 * between `pnpm dev`, a bare `tsx`, and CI — we walk up and find it.
 *
 * Variables already present in the real environment always win, so a deployed
 * environment is never overridden by a stray file.
 */
export function loadEnv(startDir: string = __dirname): void {
  let dir = startDir;

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.env');

    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No .env found. That is normal in production, where configuration comes
  // from the environment itself; validateEnv will fail loudly if it is missing.
}
