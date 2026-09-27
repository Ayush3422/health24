import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runDrill, type DrillResult } from '../src/db/restore-drill';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * The drill, run (sp7-plan.md, T19, T20, DF7).
 *
 * An untested backup is not a backup, and a drill that only exists as a script
 * nobody runs is not a test. So it runs here: a patient is registered, the
 * database is dumped and restored into a scratch copy, and then the two claims
 * that matter are checked separately —
 *
 *   1. the restored copy holds the record, with row-level security still doing
 *      its job, and
 *   2. the application boots against it, and a member of staff signs in and
 *      reads that patient through the API.
 *
 * The second is the one people forget. A dump that restores but that the
 * application cannot run on is a dump that will be found useless on the day it
 * is needed.
 *
 * The timings are printed rather than asserted: what they are on a laptop says
 * nothing about production, and what they are *for* is being written into
 * `docs/runbooks/restore.md`, so that a recovery time somebody promises is one
 * that has been measured.
 */
describe('the restore drill', () => {
  let ctx: TestContext | null = null;
  let desk: SeededStaff;
  let drill: DrillResult;

  const PATIENT = 'Lakshmi Restored';
  const scratch = 'health24_drill_spec';
  let mrn: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const seeded = await seedHospital({ name: 'Restore Drill Hospital', mrnPrefix: 'RDH' });
    desk = seeded.staff.frontDesk as SeededStaff;

    const token = await signIn(ctx, desk);
    const registered = await ctx
      .http()
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: PATIENT, gender: 'female', dateOfBirth: '1968-04-12' });

    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    mrn = registered.body.patient.mrn as string;

    // Closed before the dump: the drill drops and recreates its scratch
    // database, and open connections make that flaky.
    await ctx.close();
    ctx = null;

    // The harness has already repointed these at the test database.
    drill = await runDrill({
      sourceUrl: process.env.DATABASE_ADMIN_URL!,
      appUrl: process.env.DATABASE_URL!,
      scratchDatabase: scratch,
      log: () => {},
    });
  }, 300_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('restores, and the restored copy answers correctly', () => {
    for (const check of drill.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }

    expect(drill.ok).toBe(true);
    expect(drill.dumpBytes).toBeGreaterThan(0);
  });

  it('boots the application against the restored copy, and reads the patient', async () => {
    // A fresh module registry: the database connection is built when the module
    // is first imported, so the application has to be rebuilt to point
    // anywhere else.
    vi.resetModules();
    const restored = await createTestApp({ database: scratch });

    try {
      const ready = await restored.http().get('/ready');
      expect(ready.status, JSON.stringify(ready.body)).toBe(200);
      expect(ready.body.checks.migrations.state).toBe('up');

      // The same account, the same password, the same second factor — all of it
      // came back with the restore, which is what makes this a usable copy
      // rather than a readable one.
      const token = await signIn(restored, desk);

      const found = await restored
        .http()
        .get(`/api/v1/patients?q=${encodeURIComponent(PATIENT)}`)
        .set('Authorization', `Bearer ${token}`);

      expect(found.status, JSON.stringify(found.body)).toBe(200);
      expect(
        (found.body.results as Array<{ name: string; mrn: string | null }>).map((row) => row.name),
      ).toContain(PATIENT);
      expect(
        (found.body.results as Array<{ mrn: string | null }>).map((row) => row.mrn),
      ).toContain(mrn);
    } finally {
      await restored.close();
    }
  }, 180_000);

  it('says how long it took, for the runbook', () => {
    const { dumpMs, restoreMs, verifyMs, totalMs } = drill.timings;

    console.info(
      `[restore drill] ${(drill.dumpBytes / 1024 / 1024).toFixed(2)} MB — ` +
        `dump ${String(dumpMs)} ms, restore ${String(restoreMs)} ms, ` +
        `verify ${String(verifyMs)} ms, total ${String(totalMs)} ms`,
    );

    expect(totalMs).toBeGreaterThan(0);
  });
});
