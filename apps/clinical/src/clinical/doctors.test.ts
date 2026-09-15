import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@health24/shared';
import { groupByDoctor } from './DoctorsAndTreatment';

const own = { id: '00000000-0000-4000-8000-000000000001', name: 'City General', isOwn: true };
const other = { id: '00000000-0000-4000-8000-000000000002', name: 'Sanjeevani', isOwn: false };
const nair = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Dr. Arun Nair' };
const joshi = { id: '00000000-0000-4000-8000-0000000000b2', name: 'Vd. Meera Joshi' };

let sequence = 0;
const item = (overrides: Partial<TimelineItem>): TimelineItem => ({
  kind: 'diagnosis',
  id: `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, '0')}`,
  at: '2026-09-01T10:00:00+05:30',
  category: 'diagnoses',
  hospital: own,
  encounterId: null,
  systemOfMedicine: 'allopathy',
  title: 'Gastritis',
  detail: null,
  clinician: nair,
  entry: { source: 'direct', enteredBy: nair },
  corrected: false,
  ...overrides,
});

describe('grouping the record by doctor', () => {
  it('puts each doctor’s diagnoses, medicines, procedures, notes and visits together, most recently seen first', () => {
    const groups = groupByDoctor([
      item({ kind: 'prescription', title: 'Pantoprazole', at: '2026-09-12T10:00:00+05:30' }),
      item({ kind: 'diagnosis', title: 'Gastritis', at: '2026-09-12T09:55:00+05:30' }),
      item({ kind: 'encounter', title: 'Outpatient visit', at: '2026-09-12T09:30:00+05:30' }),
      item({
        kind: 'diagnosis',
        title: 'Amlapitta',
        at: '2026-08-03T11:00:00+05:30',
        hospital: other,
        clinician: joshi,
        systemOfMedicine: 'ayurveda',
      }),
      item({ kind: 'vitals', title: 'BP 120/80' }),
      item({ kind: 'allergy', title: 'Penicillin' }),
    ]);

    expect(groups.map((group) => group.clinician.name)).toEqual(['Dr. Arun Nair', 'Vd. Meera Joshi']);

    const [first, second] = groups;
    expect(first!.diagnoses.map((entry) => entry.title)).toEqual(['Gastritis']);
    expect(first!.prescriptions.map((entry) => entry.title)).toEqual(['Pantoprazole']);
    expect(first!.visits).toHaveLength(1);
    expect(first!.lastSeen).toBe('2026-09-12T10:00:00+05:30');
    expect(second!.hospital.isOwn).toBe(false);
    expect(second!.systems).toEqual(['ayurveda']);
  });

  it('keeps the same clinician at two hospitals apart', () => {
    const groups = groupByDoctor([item({}), item({ hospital: other })]);
    expect(groups).toHaveLength(2);
  });
});
