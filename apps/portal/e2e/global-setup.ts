import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { seedSp6 } from './seed-sp6';

/**
 * Everything the browser tests need, in the order it has to happen.
 *
 * Playwright starts a configured `webServer` before the global setup runs, and
 * the API cannot start before its database exists — so the servers are started
 * here instead, after the fixture has been laid down.
 *
 * Three processes, on ports of their own: nothing here touches the developer's
 * API on 3000 or their portal on 5174, and a queue name unique to the run
 * keeps a worker somebody left running from taking these jobs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(HERE, '..', 'test-results');

export const API_PORT = 3100;
export const PORTAL_PORT = 5175;
/** The clinical app, whose SP6 screens are tested beside the portal (T25). */
export const CLINICAL_PORT = 5176;

const RUN = `e2e-${process.pid}`;

function databaseUrl(variable: 'DATABASE_URL' | 'DATABASE_ADMIN_URL'): string {
  const base = process.env[variable];
  if (!base) throw new Error(`${variable} is not set — the browser tests need a local database`);

  const url = new URL(base);
  url.pathname = `/${process.env.E2E_DATABASE ?? 'health24_e2e'}`;
  return url.toString();
}

/** Runs a command to completion, with its output on this terminal. */
function run(command: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: REPO, shell: true, stdio: 'inherit' });

    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited with ${String(code)}`)),
    );
  });
}

/** True once the run is over, when a server's dying breath is not a failure. */
let stopping = false;

function start(command: string, label: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, {
    cwd: REPO,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  // Kept quiet unless something goes wrong: a failing test is easier to read
  // without a server's log between every step.
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(chunk.toString());
    if (lines.length > 100) lines.shift();
  };

  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null && !stopping) {
      console.error(`${label} exited with ${String(code)}:\n${lines.join('')}`);
    }
  });

  return child;
}

async function waitFor(url: string, label: string): Promise<void> {
  const until = Date.now() + 90_000;

  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }

    if (Date.now() > until) throw new Error(`${label} did not answer on ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Ends a process and the shell it was started through, and waits for it.
 *
 * Waiting matters on Windows, where the tree is killed by another process
 * entirely: without it the next run starts while these still hold the ports,
 * and quietly tests the previous run's servers.
 */
async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;

  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => killer.once('exit', () => resolve()));
  } else {
    child.kill('SIGTERM');
  }

  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  dotenv.config({ path: path.join(REPO, '.env') });

  mkdirSync(OUT, { recursive: true });
  const smsFile = path.join(OUT, 'sms.jsonl');
  rmSync(smsFile, { force: true });

  // Read by the tests themselves: they run in worker processes started after
  // this one, and inherit what is set here.
  process.env.SMS_LOG_FILE = smsFile;
  process.env.E2E_DATABASE_ADMIN_URL = databaseUrl('DATABASE_ADMIN_URL');
  process.env.E2E_STAFF_FILE = path.join(OUT, 'e2e-staff.json');
  process.env.E2E_SP6_FILE = path.join(OUT, 'sp6.json');

  // The API is run from its build, not from its sources: Nest's dependency
  // injection reads the type metadata TypeScript emits, and the quick
  // transpilers that would otherwise serve here do not emit it.
  await run('pnpm --filter "@health24/api..." build', 'the build');
  await run('pnpm --filter @health24/api db:e2e-fixture', 'the fixture');

  const apiEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    DATABASE_URL: databaseUrl('DATABASE_URL'),
    DATABASE_ADMIN_URL: process.env.E2E_DATABASE_ADMIN_URL,
    SMS_PROVIDER: 'log',
    SMS_LOG_FILE: smsFile,
    CORS_ORIGINS: `http://localhost:${PORTAL_PORT},http://localhost:${CLINICAL_PORT}`,
    LOG_LEVEL: 'warn',
    NOTIFICATION_QUEUE_NAME: `patient-notifications-${RUN}`,
    EXPORT_QUEUE_NAME: `patient-exports-${RUN}`,
    SCAN_QUEUE_NAME: `document-scans-${RUN}`,
  };

  const api = start('node apps/api/dist/main.js', 'the API', apiEnv);
  const worker = start('node apps/api/dist/worker.js', 'the worker', apiEnv);
  const portal = start(
    `pnpm --filter @health24/portal exec vite --port ${PORTAL_PORT} --strictPort`,
    'the portal',
    { API_ORIGIN: `http://localhost:${API_PORT}` },
  );
  const clinical = start(
    `pnpm --filter @health24/clinical exec vite --port ${CLINICAL_PORT} --strictPort`,
    'the clinical app',
    { API_ORIGIN: `http://localhost:${API_PORT}` },
  );

  const servers = [api, worker, portal, clinical];

  try {
    await waitFor(`http://localhost:${API_PORT}/health`, 'The API');
    await waitFor(`http://localhost:${PORTAL_PORT}/`, 'The portal');
    await waitFor(`http://localhost:${CLINICAL_PORT}/`, 'The clinical app');

    // What SP6 left on the screens, created through the API by the staff who
    // would have created it (T25). The tests read the figures back.
    const seeded = await seedSp6(`http://localhost:${API_PORT}`);
    writeFileSync(process.env.E2E_SP6_FILE, JSON.stringify(seeded, null, 2), 'utf8');
  } catch (error: unknown) {
    await Promise.all(servers.map(stop));
    throw error;
  }

  return async () => {
    stopping = true;
    await Promise.all(servers.map(stop));
  };
}
