import { describe, expect, it } from 'vitest';
import { REDACTED, looksLikePersonalData, scrub, scrubText } from './scrub';

/**
 * That a patient cannot reach a log line (sp7-plan.md, T6, DF4).
 *
 * The cases below are the ways it actually happens: a value under a key
 * somebody added, a name interpolated into a message, an error whose text
 * quotes the row that failed to insert, a phone number in a URL.
 */
describe('scrubbing a log line', () => {
  describe('by key', () => {
    it('takes out who the person is', () => {
      const line = scrub({
        patientId: '01a0d7c3-a410-7273-864b-ad9f69444495',
        name: 'Lakshmi Iyer',
        phone: '9820055001',
        dateOfBirth: '1968-04-12',
        mrn: 'SAE-000001',
        hospitalId: '01a0d7c3-0000-7273-864b-ad9f69444495',
      }) as Record<string, string>;

      // The identifiers stay: they are how the row is found, under the
      // controls that protect it.
      expect(line.patientId).toBe('01a0d7c3-a410-7273-864b-ad9f69444495');
      expect(line.hospitalId).toBe('01a0d7c3-0000-7273-864b-ad9f69444495');

      expect(line.name).toBe(REDACTED);
      expect(line.phone).toBe(REDACTED);
      expect(line.dateOfBirth).toBe(REDACTED);
      expect(line.mrn).toBe(REDACTED);
    });

    it('takes out what is wrong with them', () => {
      const line = scrub({
        conditionId: 'c1',
        display: 'Amlapitta',
        chiefComplaint: 'Burning after meals for three months',
        medicineName: 'Avipattikar churna',
        operativeNote: 'Distal stricture dilated and a stent placed.',
      }) as Record<string, string>;

      expect(line.conditionId).toBe('c1');
      expect(line.display).toBe(REDACTED);
      expect(line.chiefComplaint).toBe(REDACTED);
      expect(line.medicineName).toBe(REDACTED);
      expect(line.operativeNote).toBe(REDACTED);
    });

    it('does not care how the key is spelled', () => {
      const line = scrub({
        patient_name: 'Lakshmi Iyer',
        'PATIENT-NAME': 'Lakshmi Iyer',
        patientName: 'Lakshmi Iyer',
      }) as Record<string, string>;

      expect(Object.values(line)).toEqual([REDACTED, REDACTED, REDACTED]);
    });

    it('takes out credentials, which belong in a log even less', () => {
      const line = scrub({
        password: 'hunter2',
        refreshToken: 'abc',
        authorization: 'Bearer abc',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      }) as Record<string, string>;

      expect(Object.values(line)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
    });

    it('reaches inside nested objects and arrays', () => {
      const line = scrub({
        results: [{ patient: { name: 'Lakshmi Iyer', id: 'p1' } }],
      }) as { results: Array<{ patient: Record<string, string> }> };

      expect(line.results[0]!.patient.name).toBe(REDACTED);
      expect(line.results[0]!.patient.id).toBe('p1');
    });
  });

  describe('by shape, wherever it appears', () => {
    it('takes a mobile number out of a sentence', () => {
      expect(scrubText('No account for 9820055001')).toBe(`No account for ${REDACTED}`);
      expect(scrubText('No account for +91 98200 55001')).toBe(`No account for ${REDACTED}`);
      expect(scrubText('No account for 98200-55001')).toBe(`No account for ${REDACTED}`);
    });

    it('takes an email address, an MRN and an Aadhaar number', () => {
      expect(scrubText('login failed for meera.joshi@sae.example.in')).toContain(REDACTED);
      expect(scrubText('merging SAE-000001 into SAE-000002')).toBe(
        `merging ${REDACTED} into ${REDACTED}`,
      );
      expect(scrubText('aadhaar 1234 5678 9012 given')).toBe(`aadhaar ${REDACTED} given`);
    });

    it('leaves what a log is for alone', () => {
      const line = 'GET /api/v1/patients/01a0d7c3-a410-7273-864b-ad9f69444495/timeline 200 in 42ms';
      expect(scrubText(line)).toBe(line);
      expect(looksLikePersonalData(line)).toBe(false);
    });

    it('scrubs the message an error carries, and keeps its shape', () => {
      const error = new Error('duplicate key value violates unique constraint: 9820055001');
      const scrubbed = scrub(error) as { name: string; message: string; stack?: string };

      expect(scrubbed.name).toBe('Error');
      expect(scrubbed.message).toContain(REDACTED);
      expect(scrubbed.message).not.toContain('9820055001');
      expect(scrubbed.stack).toBeTruthy();
    });
  });

  describe('as a whole', () => {
    it('keeps a log line readable', () => {
      const line = scrub({
        requestId: 'r1',
        route: 'POST /api/v1/patients',
        statusCode: 201,
        durationMs: 42,
        ok: true,
      });

      expect(line).toEqual({
        requestId: 'r1',
        route: 'POST /api/v1/patients',
        statusCode: 201,
        durationMs: 42,
        ok: true,
      });
    });

    it('refuses to recurse or grow without limit', () => {
      let deep: Record<string, unknown> = { name: 'Lakshmi Iyer' };
      for (let level = 0; level < 12; level += 1) deep = { deep };

      expect(JSON.stringify(scrub(deep))).toContain('[too deep]');
      expect(JSON.stringify(scrub(deep))).not.toContain('Lakshmi');

      const many = scrub(Array.from({ length: 80 }, (_, index) => index)) as unknown[];
      expect(many).toHaveLength(51);
      expect(many.at(-1)).toBe('[+30 more]');
    });
  });
});
