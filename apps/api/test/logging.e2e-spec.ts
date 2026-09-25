import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * That a patient cannot reach a log line (sp7-plan.md, T6, DF4).
 *
 * The unit tests prove the scrubber is right. This proves it is actually in
 * the way: a real application, writing a real log, while a patient is
 * registered, searched for by name, read, and made to cause an error — and
 * then every line of that log is read back and checked.
 *
 * The values below are deliberately the ones an operator would most want to
 * grep for, which is exactly why they must not be there: a log aggregator is
 * a copy of the record with none of its protections.
 */
describe('the log', () => {
  let ctx: TestContext;
  let directory: string;
  let logFile: string;

  const PATIENT = {
    name: 'Lakshmi Logtest',
    gender: 'female',
    dateOfBirth: '1968-04-12',
    phone: '9820055123',
  };

  let patientId: string;
  let mrn: string;
  let deskToken: string;

  const lines = (): string[] =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

  beforeAll(async () => {
    await resetDatabase();

    directory = mkdtempSync(path.join(tmpdir(), 'health24-log-'));
    logFile = path.join(directory, 'api.jsonl');
    process.env.LOG_FILE = logFile;
    process.env.LOG_LEVEL = 'debug';

    // The logger is built when the module file is first imported, so the
    // application has to be built afresh for it to pick the file up.
    vi.resetModules();
    ctx = await createTestApp();

    const seeded = await seedHospital({ name: 'Logging Test Hospital', mrnPrefix: 'LGT' });
    deskToken = await signIn(ctx, seeded.staff.frontDesk as SeededStaff);

    const registered = await ctx
      .http()
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${deskToken}`)
      .send(PATIENT);

    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    patientId = registered.body.patient.id as string;
    mrn = registered.body.patient.mrn as string;
  }, 180_000);

  afterAll(async () => {
    delete process.env.LOG_FILE;
    await ctx?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes structured lines with a request id', async () => {
    const response = await ctx
      .http()
      .get(`/api/v1/patients/${patientId}`)
      .set('Authorization', `Bearer ${deskToken}`);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();

    const parsed = lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.length).toBeGreaterThan(0);

    const served = parsed
      .map((line) => line.req)
      .filter((req): req is Record<string, unknown> => typeof req === 'object' && req !== null);

    expect(served.length).toBeGreaterThan(0);
    // The id is what lets one line be lined up with the rest of the request.
    expect(served.every((req) => typeof req.id === 'string')).toBe(true);
    expect(served.every((req) => typeof req.path === 'string')).toBe(true);
  });

  it('never writes the patient’s name, phone or MRN — however they got there', async () => {
    // A search by name, which puts it in the query string…
    await ctx
      .http()
      .get(`/api/v1/patients?q=${encodeURIComponent(PATIENT.name)}`)
      .set('Authorization', `Bearer ${deskToken}`);

    // …a lookup by phone, which puts it in a body…
    await ctx
      .http()
      .post('/api/v1/patients/lookup')
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ phone: PATIENT.phone });

    // …and a registration that fails validation, which quotes what was sent.
    await ctx
      .http()
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ ...PATIENT, dateOfBirth: 'the fourth of April' });

    const log = lines().join('\n');

    expect(log).not.toContain(PATIENT.name);
    expect(log).not.toContain('Logtest');
    expect(log).not.toContain(PATIENT.phone);
    expect(log).not.toContain(mrn);
    expect(log).not.toContain(PATIENT.dateOfBirth);
  });

  it('still says enough to find the row under the controls that protect it', () => {
    const log = lines().join('\n');

    // Identifiers, routes and statuses are what an operator actually needs.
    expect(log).toContain(patientId);
    expect(log).toContain('/api/v1/patients');
    expect(log).toContain('"statusCode":200');
  });

  it('keeps what a clinician wrote out of the log as well', async () => {
    const clinician = await seedHospital({ name: 'Logging Clinical', mrnPrefix: 'LGC' });
    const token = await signIn(ctx, clinician.staff.clinician as SeededStaff);

    const registered = await ctx
      .http()
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ganesh Logtest', gender: 'male', dateOfBirth: '1962-11-30' });

    const encounter = await ctx
      .http()
      .post('/api/v1/encounters')
      .set('Authorization', `Bearer ${token}`)
      .send({
        patientId: registered.body.patient.id,
        chiefComplaint: 'Burning after meals for three months',
      });

    expect(encounter.status, JSON.stringify(encounter.body)).toBe(201);

    expect(lines().join('\n')).not.toContain('Burning after meals');
  });
});
