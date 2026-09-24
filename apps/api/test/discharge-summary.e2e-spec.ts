import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { StorageService } from '../src/modules/storage/storage.service';
import {
  appRoleDb,
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

type Section = { key: string; label: string; text: string; composed: boolean };
type Summary = {
  id: string;
  status: 'draft' | 'signed';
  sections: Section[];
  signedAt: string | null;
  signedBy: { id: string; name: string | null } | null;
  noteId: string | null;
  documentId: string | null;
};

const textOf = (summary: Summary, key: string): string =>
  summary.sections.find((section) => section.key === key)?.text ?? '';

/**
 * The discharge summary (sp6-plan.md, Phase 5, DF6 and DF7): composed from the
 * encounter's own data, edited, and signed — and only then a record.
 */
describe('the discharge summary', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalId: string;
  let clinicianToken: string;
  let recordsToken: string;
  let deskToken: string;
  let adminToken: string;
  let clinician: SeededStaff;

  let patientId: string;
  let encounterId: string;
  let summaryId: string;

  const post = (path: string, bearer: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    await ctx.app.get(StorageService).ensureBucket();

    const a = await seedHospital({ name: 'Sanjeevani Discharge Test', mrnPrefix: 'SDT' });
    hospitalId = a.hospital.id;
    clinician = a.staff.clinician as SeededStaff;

    clinicianToken = await signIn(ctx, clinician);
    recordsToken = await signIn(ctx, a.staff.records as SeededStaff);
    deskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    adminToken = await signIn(ctx, a.staff.admin as SeededStaff);

    patientId = (
      await post('/patients', deskToken, {
        name: 'Discharged Patient',
        gender: 'female',
        dateOfBirth: '1959-11-02',
        phone: '9820099001',
      })
    ).body.patient.id;

    encounterId = (
      await post('/encounters', clinicianToken, {
        patientId,
        class: 'inpatient',
        chiefComplaint: 'Fever for five days, not settling at home',
      })
    ).body.id;

    // The record the summary will be composed from: a bed, a diagnosis, an
    // operation with a device, a lab result and a medicine.
    const ward = (
      await post('/wards', adminToken, { name: 'Medical ward', kind: 'general', beds: ['M1'] })
    ).body;

    await post('/admissions', deskToken, { encounterId, bedId: ward.beds[0].id });

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    // The diagnosis goes in directly: coding it through the API would need a
    // terminology release loaded, and what this suite is about is the summary.
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [condition] = await tx<Array<{ id: string }>>`
        INSERT INTO condition (patient_id, hospital_id, encounter_id, clinical_status,
                               verification_status, is_primary, attributed_clinician_id,
                               recorded_by_staff_id)
        VALUES (${patientId}, ${hospitalId}, ${encounterId}, 'active', 'confirmed', true,
                ${clinician.id}, ${clinician.id})
        RETURNING id
      `;

      await tx`
        INSERT INTO condition_coding (condition_id, role, code_system_key, code_system_version,
                                      code, display)
        VALUES (${condition!.id}, 'primary', 'NAMASTE', '2024', 'AYU-JVARA', 'Jvara')
      `;
    });

    const procedure = await post('/procedures', clinicianToken, {
      encounterId,
      name: 'Incision and drainage',
      anaesthesia: 'Local',
      operativeNote: 'Abscess drained. Cavity washed out.',
      postOpCourse: 'Settled overnight; fever down by the morning.',
      outcome: 'Uncomplicated',
    });

    await post('/implants', clinicianToken, {
      encounterId,
      procedureId: procedure.body.id,
      name: 'Drain',
      serialOrLot: 'DR-99',
    });

    await post('/results', clinicianToken, {
      patientId,
      encounterId,
      panel: 'lft',
      collectedAt: new Date(Date.now() - 3_600_000).toISOString(),
      results: [{ code: '1742-6', value: 71, unit: 'U/L', referenceLow: 7, referenceHigh: 56 }],
    });

    await post('/prescriptions', clinicianToken, {
      encounterId,
      medicineName: 'Amoxicillin',
      strength: '500 mg',
      frequency: '1-1-1',
      route: 'oral',
      durationValue: 5,
      durationUnit: 'days',
    });
  }, 180_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('is composed from the encounter’s own data, and invents nothing', async () => {
    const composed = await post('/discharge-summaries', clinicianToken, { encounterId });
    expect(composed.status, JSON.stringify(composed.body)).toBe(201);

    const summary = composed.body as Summary;
    summaryId = summary.id;

    expect(summary.status).toBe('draft');
    expect(textOf(summary, 'admission')).toContain('Medical ward · M1');
    expect(textOf(summary, 'admission')).toContain('Fever for five days');
    expect(textOf(summary, 'diagnoses')).toContain('Jvara');
    expect(textOf(summary, 'procedures')).toContain('Incision and drainage');
    expect(textOf(summary, 'procedures')).toContain('DR-99');
    expect(textOf(summary, 'investigations')).toContain('71 U/L');
    expect(textOf(summary, 'medicines')).toContain('Amoxicillin 500 mg');
    // The surgeon's own words about the course, not the system's.
    expect(textOf(summary, 'course')).toContain('Settled overnight');

    // What only a clinician can say is left for them to say.
    expect(textOf(summary, 'condition')).toBe('');
    expect(textOf(summary, 'advice')).toBe('');
    expect(textOf(summary, 'follow_up')).toBe('');
  });

  it('keeps the clinician’s words when it is composed again', async () => {
    const edited = await post(`/discharge-summaries/${summaryId}`, clinicianToken, {
      sections: [
        { key: 'condition', text: 'Afebrile for 24 hours, eating well, wound clean.' },
        { key: 'advice', text: 'Keep the dressing dry. Return if the fever comes back.' },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(textOf(edited.body, 'condition')).toContain('Afebrile');

    // A late result arrives, and composition pulls it in…
    await post('/results', clinicianToken, {
      patientId,
      encounterId,
      panel: 'lft',
      collectedAt: new Date().toISOString(),
      results: [{ code: '1742-6', value: 48, unit: 'U/L', referenceLow: 7, referenceHigh: 56 }],
    });

    const again = await post('/discharge-summaries', clinicianToken, { encounterId });
    expect(again.status).toBe(201);
    expect(textOf(again.body, 'investigations')).toContain('48 U/L');

    // …without touching what somebody wrote.
    expect(textOf(again.body, 'condition')).toContain('Afebrile');
    expect(textOf(again.body, 'advice')).toContain('Keep the dressing dry');
  });

  it('is not signed by records staff, whose work is transcription', async () => {
    const refused = await post(`/discharge-summaries/${summaryId}/sign`, recordsToken, {
      confirmed: true,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);

    // They may still compose and edit the draft for the clinician.
    const edited = await post(`/discharge-summaries/${summaryId}`, recordsToken, {
      sections: [{ key: 'follow_up', text: 'Review in the outpatient clinic in one week.' }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  });

  it('signing writes the note and the PDF, and closes the summary to further change', async () => {
    const signed = await post(`/discharge-summaries/${summaryId}/sign`, clinicianToken, {
      confirmed: true,
    });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);

    const summary = signed.body as Summary;
    expect(summary).toMatchObject({ status: 'signed', signedBy: { id: clinician.id } });
    expect(summary.noteId).toBeTruthy();
    expect(summary.documentId).toBeTruthy();

    // The note is the record: a versioned clinical note on the encounter.
    const notes = await get(`/encounters/${encounterId}/notes`, clinicianToken);
    const note = notes.body.find((row: { id: string }) => row.id === summary.noteId);
    expect(note).toMatchObject({ template: 'discharge_summary', title: 'Discharge summary' });
    const said = (note.sections as Array<{ key: string; text: string }>)
      .map((section) => section.text)
      .join(' ');
    expect(said).toContain('Afebrile');
    expect(said).toContain('Jvara');

    // The PDF is a document of the patient's record, readable at once.
    const documents = await get(`/patients/${patientId}/documents`, clinicianToken);
    const document = documents.body.results.find(
      (row: { id: string }) => row.id === summary.documentId,
    );
    expect(document).toMatchObject({
      docType: 'discharge_summary',
      title: 'Discharge summary',
      availability: 'available',
    });

    const [file] = await owner<
      Array<{ storage_key: string; size_bytes: number; scan_status: string }>
    >`
      SELECT storage_key, size_bytes, scan_status FROM document_file
       WHERE document_id = ${summary.documentId!}
    `;
    expect(file).toMatchObject({ scan_status: 'clean' });
    expect(file!.size_bytes).toBeGreaterThan(500);

    const stored = await ctx.app.get(StorageService).describe(file!.storage_key);
    expect(stored?.contentType).toBe('application/pdf');

    // And the summary itself is closed: no more editing, no second signature.
    expect(
      (
        await post(`/discharge-summaries/${summaryId}`, clinicianToken, {
          sections: [{ key: 'advice', text: 'Something else' }],
        })
      ).status,
    ).toBe(409);

    expect(
      (await post(`/discharge-summaries/${summaryId}/sign`, clinicianToken, { confirmed: true }))
        .status,
    ).toBe(409);

    expect((await post('/discharge-summaries', clinicianToken, { encounterId })).status).toBe(409);
  });

  it('in the database, a signed summary cannot be rewritten or deleted', async () => {
    const { client: app, close } = appRoleDb();

    try {
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE discharge_summary SET sections = '[]'::jsonb WHERE id = ${summaryId}`;
        }),
      ).rejects.toThrow(/signed discharge summary cannot be changed/);

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`DELETE FROM discharge_summary WHERE id = ${summaryId}`;
        }),
      ).rejects.toThrow(/permission denied|never deleted/);
    } finally {
      await close();
    }
  });

  it('belongs to an admission, not to an outpatient visit', async () => {
    const outpatient = (await post('/encounters', clinicianToken, { patientId })).body.id;

    const refused = await post('/discharge-summaries', clinicianToken, {
      encounterId: outpatient,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  });
});
