import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { loadEnv } from '../config/load-env';

loadEnv();

/**
 * Restoring a backup, and proving the record is in it (sp7-plan.md, T19, DF7).
 *
 * An untested backup is not a backup. This is the test: take a dump, restore it
 * into a scratch database nobody is using, and then ask the restored copy the
 * questions that matter — is the record there, is row-level security still in
 * force, is the schema the version the code expects. It reports how long each
 * step took, because a restore time nobody has measured is a restore time
 * nobody can promise.
 *
 * It runs against a local database here and against the CI service container
 * there. In production the dump comes from a point-in-time restore of the RDS
 * instance instead, which is the same three steps with AWS doing the first one
 * — `docs/runbooks/restore.md` walks that version.
 *
 * Nothing in it writes to the source. A drill that could damage what it is
 * checking is not a drill anybody will run.
 */

export interface DrillOptions {
  /** The database to copy, as the owner. */
  sourceUrl: string;
  /** The application's own connection, used to verify the restored copy. */
  appUrl: string;
  /** The scratch database to restore into. Dropped first, every time. */
  scratchDatabase?: string;
  /** Where the dump file is written. A temporary directory by default. */
  dumpDirectory?: string;
  /** Printed as it goes, unless a test would rather be quiet. */
  log?: (line: string) => void;
}

export interface DrillResult {
  scratchDatabase: string;
  dumpFile: string;
  dumpBytes: number;
  timings: { dumpMs: number; restoreMs: number; verifyMs: number; totalMs: number };
  /** What the restored copy said, and what was expected of it. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  ok: boolean;
}

const DEFAULT_SCRATCH = 'health24_restore_drill';
const POSTGRES_IMAGE = 'postgres:16-alpine';

/** A URL with its database name replaced. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });

    const said: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => said.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => said.push(chunk.toString()));

    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(said.join(''))
        : reject(new Error(`${command} exited with ${String(code)}:\n${said.join('')}`)),
    );
  });
}

/**
 * The major version of a client tool, or null when it is not installed.
 *
 * Checked rather than assumed: `pg_dump` refuses to dump a server newer than
 * itself, and a machine with last year's client would otherwise fail the drill
 * for a reason that has nothing to do with the backup.
 */
async function toolMajor(tool: string): Promise<number | null> {
  try {
    const said = await run(tool, ['--version']);
    const major = /(\d+)/.exec(said);
    return major ? Number(major[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Runs a Postgres client tool, from the machine or from a container.
 *
 * `pg_dump` and `pg_restore` have to match the server's major version, and a
 * developer's machine often has neither. Rather than making the drill something
 * only CI can run — which is how a drill stops being run at all — it falls back
 * to the same image the database itself runs from.
 */
async function pgTool(
  tool: 'pg_dump' | 'pg_restore',
  args: string[],
  context: { url: string; dumpDirectory: string; serverMajor: number },
): Promise<void> {
  const major = await toolMajor(tool);

  if (major !== null && major >= context.serverMajor) {
    await run(tool, args);
    return;
  }

  // Inside a container, `localhost` is the container. Docker Desktop publishes
  // the host under this name; on Linux the tool is on PATH and this is unused.
  const url = new URL(context.url);
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    url.hostname = 'host.docker.internal';
  }

  // Paths are rewritten to the mount point, separators and all: a Windows path
  // handed to a Linux container is a filename with backslashes in it, and the
  // dump lands somewhere nobody looks.
  const rewritten = args.map((argument) =>
    argument.includes(context.url)
      ? argument.replace(context.url, url.toString())
      : argument.replace(context.dumpDirectory, '/dump').split('\\').join('/'),
  );

  await run('docker', [
    'run',
    '--rm',
    '--add-host',
    'host.docker.internal:host-gateway',
    '-v',
    `${context.dumpDirectory}:/dump`,
    POSTGRES_IMAGE,
    tool,
    ...rewritten,
  ]);
}

/** Drops and recreates the scratch database, as the owner. */
async function freshScratch(sourceUrl: string, scratch: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(scratch)) {
    throw new Error(`Unsafe database name: ${scratch}`);
  }

  if (scratch === databaseOf(sourceUrl)) {
    throw new Error('The scratch database cannot be the database being copied');
  }

  const maintenance = postgres(withDatabase(sourceUrl, 'postgres'), {
    max: 1,
    onnotice: () => {},
  });

  try {
    // Anything still connected would block the drop.
    await maintenance.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${scratch}'`,
    );
    await maintenance.unsafe(`DROP DATABASE IF EXISTS ${scratch}`);
    await maintenance.unsafe(`CREATE DATABASE ${scratch}`);
  } finally {
    await maintenance.end({ timeout: 5 });
  }
}

/**
 * What the restored copy has to be able to answer.
 *
 * Asked as the application's own unprivileged role, not as the owner: a restore
 * that only the owner can read is a restore the application cannot use, and
 * row-level security is the one property most likely to be lost by a careless
 * dump.
 */
async function verify(
  appScratchUrl: string,
  ownerScratchUrl: string,
  expected: { schemaVersion: number },
): Promise<DrillResult['checks']> {
  const app = postgres(appScratchUrl, { max: 1, onnotice: () => {} });
  const owner = postgres(ownerScratchUrl, { max: 1, onnotice: () => {} });
  const checks: DrillResult['checks'] = [];

  try {
    const [version] = await app<Array<{ version: number }>>`SELECT app.schema_version() AS version`;
    checks.push({
      name: 'schema version',
      ok: Number(version?.version) === expected.schemaVersion,
      detail: `restored ${String(version?.version)}, expected ${String(expected.schemaVersion)}`,
    });

    // The record itself. Counted as the owner, because counting it as the
    // application would be answered by row-level security rather than by the
    // restore.
    const [counts] = await owner<Array<{ patients: number; hospitals: number; encounters: number }>>`
      SELECT (SELECT count(*)::int FROM patient) AS patients,
             (SELECT count(*)::int FROM hospital) AS hospitals,
             (SELECT count(*)::int FROM encounter) AS encounters
    `;

    checks.push({
      name: 'the record is there',
      ok: Number(counts?.patients) > 0 && Number(counts?.hospitals) > 0,
      detail: `${String(counts?.hospitals)} hospitals, ${String(counts?.patients)} patients, ${String(counts?.encounters)} encounters`,
    });

    // Row-level security, which a dump restored carelessly can lose.
    const [rls] = await owner<Array<{ unprotected: string[] }>>`
      SELECT coalesce(array_agg(c.relname ORDER BY c.relname), '{}') AS unprotected
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relname IN ('patient', 'encounter', 'condition', 'invoice', 'charge')
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    `;

    checks.push({
      name: 'row-level security survived',
      ok: (rls?.unprotected ?? []).length === 0,
      detail:
        (rls?.unprotected ?? []).length === 0
          ? 'enabled and forced on every table checked'
          : `not forced on ${(rls?.unprotected ?? []).join(', ')}`,
    });

    // And that it is actually doing something: no context, no rows.
    const [blind] = await app<Array<{ patients: number }>>`
      SELECT count(*)::int AS patients FROM patient
    `;

    checks.push({
      name: 'the application sees nothing without a context',
      ok: Number(blind?.patients) === 0,
      detail: `${String(blind?.patients)} rows visible with no hospital set`,
    });

    // With a context, the hospital's own patients are readable — which is the
    // whole point of having restored anything.
    const [hospital] = await owner<Array<{ id: string }>>`SELECT id FROM hospital LIMIT 1`;

    const readable = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_hospital_id', ${hospital!.id}, true)`;
      const [row] = await tx<Array<{ patients: number }>>`
        SELECT count(*)::int AS patients FROM patient
      `;
      return Number(row?.patients ?? 0);
    });

    checks.push({
      name: 'the record reads correctly under a context',
      ok: Number(readable) > 0,
      detail: `${String(readable)} patients readable by their own hospital`,
    });
  } finally {
    await app.end({ timeout: 5 });
    await owner.end({ timeout: 5 });
  }

  return checks;
}

export async function runDrill(options: DrillOptions): Promise<DrillResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const scratch = options.scratchDatabase ?? DEFAULT_SCRATCH;

  const dumpDirectory =
    options.dumpDirectory ?? mkdtempSync(path.join(tmpdir(), 'health24-restore-drill-'));
  if (!existsSync(dumpDirectory)) mkdirSync(dumpDirectory, { recursive: true });

  const dumpFile = path.join(dumpDirectory, 'health24.dump');
  const startedAt = Date.now();

  // The version the source is at, so the restored copy can be held to it.
  const source = postgres(options.sourceUrl, { max: 1, onnotice: () => {} });
  let schemaVersion: number;
  let serverMajor: number;

  try {
    const [row] = await source<Array<{ version: number }>>`SELECT app.schema_version() AS version`;
    schemaVersion = Number(row?.version ?? 0);

    // Which client can dump this server, decided by the server rather than by
    // what happens to be installed.
    const [server] = await source<Array<{ number: string }>>`SHOW server_version_num`;
    serverMajor = Math.floor(Number(server?.number ?? 160000) / 10000);
  } finally {
    await source.end({ timeout: 5 });
  }

  log(`Dumping ${databaseOf(options.sourceUrl)} (schema version ${String(schemaVersion)})`);
  const dumpStarted = Date.now();

  // Custom format, compressed, one file: what a restore actually wants.
  await pgTool(
    'pg_dump',
    ['--format=custom', '--no-password', `--file=${dumpFile}`, options.sourceUrl],
    { url: options.sourceUrl, dumpDirectory, serverMajor },
  );

  const dumpMs = Date.now() - dumpStarted;
  const dumpBytes = statSync(dumpFile).size;
  log(`Dumped ${(dumpBytes / 1024 / 1024).toFixed(1)} MB in ${String(dumpMs)} ms`);

  log(`Restoring into ${scratch}`);
  await freshScratch(options.sourceUrl, scratch);

  const restoreStarted = Date.now();
  const ownerScratchUrl = withDatabase(options.sourceUrl, scratch);

  await pgTool(
    'pg_restore',
    ['--no-password', '--exit-on-error', `--dbname=${ownerScratchUrl}`, dumpFile],
    { url: ownerScratchUrl, dumpDirectory, serverMajor },
  );

  const restoreMs = Date.now() - restoreStarted;
  log(`Restored in ${String(restoreMs)} ms`);

  const verifyStarted = Date.now();
  const checks = await verify(withDatabase(options.appUrl, scratch), ownerScratchUrl, {
    schemaVersion,
  });
  const verifyMs = Date.now() - verifyStarted;

  for (const check of checks) {
    log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  }

  return {
    scratchDatabase: scratch,
    dumpFile,
    dumpBytes,
    timings: { dumpMs, restoreMs, verifyMs, totalMs: Date.now() - startedAt },
    checks,
    ok: checks.every((check) => check.ok),
  };
}

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;

  if (!sourceUrl) throw new Error('DATABASE_ADMIN_URL is not set (the owner connection)');
  if (!appUrl) throw new Error('DATABASE_URL is not set (the application connection)');

  const result = await runDrill({
    sourceUrl,
    appUrl,
    scratchDatabase: process.env.RESTORE_DRILL_DATABASE,
  });

  const { dumpMs, restoreMs, verifyMs, totalMs } = result.timings;

  console.log('');
  console.log(`Dump      ${String(dumpMs)} ms`);
  console.log(`Restore   ${String(restoreMs)} ms`);
  console.log(`Verify    ${String(verifyMs)} ms`);
  console.log(`Total     ${String(totalMs)} ms`);
  console.log('');

  if (!result.ok) {
    throw new Error('The restored copy did not answer correctly. This is a failed drill.');
  }

  console.log(
    `The backup restores and the record reads. Write the total into docs/runbooks/restore.md.`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
