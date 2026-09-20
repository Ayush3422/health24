import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ExportRecord } from './export-record';

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const BODY_SIZE = 10;
const LINE = 14;
const INK = rgb(0.09, 0.13, 0.16);
const MUTED = rgb(0.31, 0.36, 0.4);

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

const day = (value: string | null) =>
  value ? istDate.format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+05:30` : value)) : '—';

const moment = (value: string | null) => (value ? istDateTime.format(new Date(value)) : '—');

const join = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' · ');

/** Lays out running text on A4 pages, wrapping to the page width. */
class Sheet {
  private page: PDFPage;
  private y: number;
  readonly pages: PDFPage[] = [];

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = this.newPage();
    this.y = PAGE.height - MARGIN;
  }

  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(page);
    return page;
  }

  private room(needed = LINE): void {
    if (this.y - needed < MARGIN + 24) {
      this.page = this.newPage();
      this.y = PAGE.height - MARGIN;
    }
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];

    for (const paragraph of text.split('\n')) {
      let current = '';

      for (const word of paragraph.split(/\s+/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > width && current) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }

      lines.push(current);
    }

    return lines;
  }

  title(text: string): void {
    this.room(30);
    this.page.drawText(text, { x: MARGIN, y: this.y - 18, size: 18, font: this.bold, color: INK });
    this.y -= 34;
  }

  heading(text: string): void {
    this.room(28);
    this.y -= 10;
    this.page.drawText(text, { x: MARGIN, y: this.y - 12, size: 13, font: this.bold, color: INK });
    this.y -= 24;
  }

  entry(heading: string, details: string[]): void {
    this.line(heading, { bold: true });
    for (const detail of details) {
      if (detail) this.line(detail, { indent: 12, muted: true });
    }
    this.y -= 4;
  }

  line(text: string, options: { bold?: boolean; muted?: boolean; indent?: number } = {}): void {
    const font = options.bold ? this.bold : this.font;
    const indent = options.indent ?? 0;
    const width = PAGE.width - 2 * MARGIN - indent;

    for (const wrapped of this.wrap(text, font, BODY_SIZE, width)) {
      this.room();
      this.page.drawText(wrapped, {
        x: MARGIN + indent,
        y: this.y - BODY_SIZE,
        size: BODY_SIZE,
        font,
        color: options.muted ? MUTED : INK,
      });
      this.y -= LINE;
    }
  }

  /** Page numbers and the note that this is a copy, on every page. */
  footer(text: string): void {
    this.pages.forEach((page, index) => {
      page.drawText(`${text} · Page ${index + 1} of ${this.pages.length}`, {
        x: MARGIN,
        y: MARGIN - 16,
        size: 8,
        font: this.font,
        color: MUTED,
      });
    });
  }
}

/**
 * The patient's whole record as a readable PDF (sp5-plan.md, Decision N1):
 * every entry, in date order, with the hospital and the clinician who
 * recorded it. Nothing is interpreted or summarised.
 */
export async function buildRecordPdf(record: ExportRecord, exportedAt: Date): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Health24 — my health record');
  doc.setCreator('Health24');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sheet = new Sheet(doc, font, bold);

  const { patient } = record;

  sheet.title('My health record');
  sheet.line(patient.name, { bold: true });
  sheet.line(
    join([
      patient.gender,
      patient.dateOfBirth ? `born ${day(patient.dateOfBirth)}` : null,
      patient.approximateAgeYears ? `about ${patient.approximateAgeYears} years old` : null,
      patient.bloodGroup && patient.bloodGroup !== 'unknown' ? `blood group ${patient.bloodGroup}` : null,
      patient.phone,
    ]),
    { muted: true },
  );
  if (patient.emergencyContactName && patient.emergencyContactPhone) {
    sheet.line(`Emergency contact: ${patient.emergencyContactName}, ${patient.emergencyContactPhone}`, {
      muted: true,
    });
  }
  sheet.line(`Exported ${istDateTime.format(exportedAt)}`, { muted: true });

  sheet.heading('Hospitals');
  for (const hospital of record.hospitals) {
    sheet.line(`${hospital.name} — hospital number ${hospital.mrn}`);
  }
  if (record.hospitals.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Visits');
  for (const visit of record.encounters) {
    sheet.entry(`${moment(visit.started_at)} — ${visit.class.replace('_', ' ')}`, [
      join([visit.hospital_name, visit.system_of_medicine, visit.clinician_name]),
      join([visit.chief_complaint, visit.status, visit.ended_at ? `ended ${moment(visit.ended_at)}` : null]),
    ]);
  }
  if (record.encounters.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Diagnoses');
  for (const condition of record.conditions) {
    const primary = condition.codings.find((coding) => coding.role === 'primary');
    sheet.entry(
      `${moment(condition.recorded_at)} — ${primary ? `${primary.display} (${primary.code})` : 'Diagnosis'}`,
      [
        join([condition.hospital_name, condition.clinician_name]),
        join([
          condition.clinical_status,
          condition.verification_status,
          condition.is_primary ? 'primary diagnosis' : null,
        ]),
        ...condition.codings
          .filter((coding) => coding.role !== 'primary')
          .map((coding) => `${coding.role}: ${coding.display} (${coding.system} ${coding.code})`),
        condition.note ?? '',
      ],
    );
  }
  if (record.conditions.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Medicines');
  for (const medicine of record.medications) {
    sheet.entry(
      `${moment(medicine.recorded_at)} — ${join([medicine.medicine_name, medicine.strength])}`,
      [
        join([medicine.dose, medicine.frequency, medicine.route, medicine.duration, medicine.status]),
        join([medicine.start_date ? `from ${day(medicine.start_date)}` : null, medicine.hospital_name, medicine.clinician_name]),
        medicine.instructions ?? '',
      ],
    );
  }
  if (record.medications.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Allergies');
  for (const allergy of record.allergies) {
    sheet.entry(`${moment(allergy.recorded_at)} — ${allergy.substance}`, [
      join([allergy.category, `${allergy.criticality.replace('_', ' ')} risk`, allergy.clinical_status]),
      join([allergy.reaction, allergy.hospital_name, allergy.clinician_name]),
    ]);
  }
  if (record.allergies.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Test results and vitals');
  for (const observation of record.observations) {
    const value = observation.value ?? observation.value_text ?? '';
    const range =
      observation.reference_low || observation.reference_high
        ? `range ${observation.reference_low ?? ''}–${observation.reference_high ?? ''}`
        : null;

    sheet.entry(
      `${moment(observation.effective_at)} — ${observation.display}: ${join([`${value}${observation.unit ? ` ${observation.unit}` : ''}`, observation.interpretation])}`,
      [join([observation.category, `${observation.code_system} ${observation.code}`, range, observation.hospital_name])],
    );
  }
  if (record.observations.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Procedures');
  for (const procedure of record.procedures) {
    sheet.entry(`${moment(procedure.performed_at)} — ${procedure.name}`, [
      join([procedure.outcome, procedure.hospital_name, procedure.clinician_name]),
    ]);
  }
  if (record.procedures.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Doctors’ notes');
  for (const note of record.notes) {
    sheet.entry(`${moment(note.recorded_at)} — ${note.title ?? note.template ?? 'Clinical note'}`, [
      join([note.hospital_name, note.clinician_name]),
      note.body,
    ]);
  }
  if (record.notes.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.heading('Reports and documents');
  for (const document of record.documents) {
    sheet.entry(`${day(document.report_date)} — ${document.doc_type.replace(/_/g, ' ')}`, [
      join([document.title, document.performing_facility, document.hospital_name]),
      `${document.file_count} file${document.file_count === 1 ? '' : 's'} — open them in the Health24 portal`,
    ]);
  }
  if (record.documents.length === 0) sheet.line('None recorded.', { muted: true });

  sheet.footer('Health24 · your record as your hospitals recorded it');

  return doc.save();
}
