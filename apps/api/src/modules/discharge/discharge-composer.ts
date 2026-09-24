import {
  DISCHARGE_SECTIONS,
  type DischargeSection,
  type DischargeSectionKey,
} from '@health24/shared';

/**
 * What the record held, gathered for composition.
 *
 * Every field is something a person recorded. Composition copies it into
 * words; it never infers, never rephrases a diagnosis, and never fills a gap
 * with a guess (sp6-plan.md, DF6).
 */
export interface DischargeSource {
  admission: {
    admittedAt: string;
    dischargedAt: string | null;
    reason: string | null;
    attending: string | null;
    systemOfMedicine: string;
    stays: Array<{ ward: string; bed: string; from: string; to: string | null; bedDays: number }>;
    bedDays: number;
  };
  diagnoses: Array<{ name: string; codes: string[]; status: string; isPrimary: boolean }>;
  procedures: Array<{
    name: string;
    performedAt: string;
    performer: string | null;
    outcome: string | null;
    operativeNote: string | null;
    anaesthesia: string | null;
    postOpCourse: string | null;
  }>;
  devices: Array<{ name: string; serialOrLot: string | null; manufacturer: string | null }>;
  results: Array<{ label: string; value: string; flag: string | null; at: string }>;
  medicines: Array<{ name: string; dose: string | null; frequency: string | null; status: string }>;
}

const istDate = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const istDateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const on = (value: string) => istDate.format(new Date(value));
const at = (value: string) => istDateTime.format(new Date(value));

const lines = (rows: string[]): string => rows.join('\n');

/** 48.0000 is how the column stores it; 48 is how a person writes it. */
export const tidyNumber = (value: string): string =>
  /^-?\d+\.\d+$/.test(value) ? value.replace(/\.?0+$/, '') : value;

/** The text each section is composed with, or an empty string for the clinician to write. */
function composeSection(key: DischargeSectionKey, source: DischargeSource): string {
  switch (key) {
    case 'admission': {
      const { admission } = source;
      const stay = admission.stays.map(
        (row) =>
          `${row.ward} · ${row.bed}: ${at(row.from)} – ${row.to ? at(row.to) : 'still there'} (${row.bedDays} bed-day${row.bedDays === 1 ? '' : 's'})`,
      );

      return lines(
        [
          `Admitted ${at(admission.admittedAt)}${admission.attending ? ` under ${admission.attending}` : ''}.`,
          admission.dischargedAt
            ? `Discharged ${at(admission.dischargedAt)}.`
            : 'Not yet discharged.',
          admission.reason ? `Reason for admission: ${admission.reason}` : '',
          ...stay,
          admission.bedDays > 0
            ? `${admission.bedDays} bed-day${admission.bedDays === 1 ? '' : 's'} in all.`
            : '',
        ].filter(Boolean),
      );
    }

    case 'diagnoses':
      return lines(
        source.diagnoses.map(
          (diagnosis) =>
            `${diagnosis.isPrimary ? 'Primary: ' : ''}${diagnosis.name}${
              diagnosis.codes.length > 0 ? ` (${diagnosis.codes.join(', ')})` : ''
            } — ${diagnosis.status}`,
        ),
      );

    case 'procedures': {
      const operations = source.procedures.map((procedure) =>
        lines(
          [
            `${procedure.name} — ${at(procedure.performedAt)}${procedure.performer ? `, ${procedure.performer}` : ''}`,
            procedure.anaesthesia ? `Anaesthesia: ${procedure.anaesthesia}` : '',
            procedure.operativeNote ? procedure.operativeNote : '',
            procedure.outcome ? `Outcome: ${procedure.outcome}` : '',
          ].filter(Boolean),
        ),
      );

      const devices = source.devices.map(
        (device) =>
          `Device: ${device.name}${device.manufacturer ? ` (${device.manufacturer})` : ''}${
            device.serialOrLot ? ` — ${device.serialOrLot}` : ''
          }`,
      );

      return lines([...operations, ...devices]);
    }

    case 'investigations':
      return lines(
        source.results.map(
          (result) =>
            `${result.label}: ${result.value}${result.flag ? ` (${result.flag})` : ''} — ${on(result.at)}`,
        ),
      );

    case 'treatment':
      return lines(
        source.medicines.map(
          (medicine) =>
            `${medicine.name}${medicine.dose ? ` ${medicine.dose}` : ''}${
              medicine.frequency ? ` · ${medicine.frequency}` : ''
            }${medicine.status === 'active' ? '' : ` · ${medicine.status}`}`,
        ),
      );

    case 'course':
      // The one place composition has words of its own to offer, and they are
      // the surgeon's: the post-operative course as it was recorded.
      return lines(
        source.procedures.map((procedure) => procedure.postOpCourse ?? '').filter(Boolean),
      );

    case 'medicines':
      return lines(
        source.medicines
          .filter((medicine) => medicine.status === 'active')
          .map(
            (medicine) =>
              `${medicine.name}${medicine.dose ? ` ${medicine.dose}` : ''}${
                medicine.frequency ? ` · ${medicine.frequency}` : ''
              }`,
          ),
      );

    // Nobody but a clinician can say how the patient was on the day, what to
    // watch for, or when to come back. Composition leaves these empty.
    case 'condition':
    case 'advice':
    case 'follow_up':
      return '';
  }
}

/**
 * The summary as composed from the record.
 *
 * `previous` is the draft being re-composed: a section somebody has edited
 * keeps their words, and only the untouched ones are refreshed. That is what
 * makes it safe to compose again after a late result arrives.
 */
export function composeSections(
  source: DischargeSource,
  previous: DischargeSection[] = [],
): DischargeSection[] {
  return DISCHARGE_SECTIONS.map((section) => {
    const before = previous.find((candidate) => candidate.key === section.key);
    const composed = composeSection(section.key, source);

    if (before && !before.composed) return { ...before, label: section.label };

    return { key: section.key, label: section.label, text: composed, composed: true };
  });
}

/** The whole summary as running text, for the note the signature writes. */
export function asNoteBody(sections: DischargeSection[]): string {
  return sections
    .filter((section) => section.text.trim().length > 0)
    .map((section) => `${section.label}\n${section.text.trim()}`)
    .join('\n\n');
}
