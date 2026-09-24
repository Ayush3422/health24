import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { DischargeSection } from '@health24/shared';
import { istDateTime, Sheet } from '../exports/pdf-sheet';

export interface DischargeHeader {
  hospitalName: string;
  patientName: string;
  mrn: string | null;
  ageGender: string | null;
  admittedAt: string;
  dischargedAt: string | null;
  signedBy: string;
  signedAt: Date;
}

/**
 * The discharge summary as the patient carries it away and the next hospital
 * reads it (sp6-plan.md, DF7).
 *
 * Only what was signed: the sections as the clinician left them, with who
 * signed and when at the foot of every page. Nothing is added here that was
 * not in the summary.
 */
export async function buildDischargePdf(
  header: DischargeHeader,
  sections: DischargeSection[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Discharge summary');
  doc.setCreator('Health24');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sheet = new Sheet(doc, font, bold);

  sheet.title('Discharge summary');
  sheet.line(header.hospitalName, { bold: true });
  sheet.line(
    [header.patientName, header.mrn ? `Hospital number ${header.mrn}` : null, header.ageGender]
      .filter(Boolean)
      .join(' · '),
  );
  sheet.line(
    `Admitted ${istDateTime.format(new Date(header.admittedAt))}${
      header.dischargedAt
        ? ` · Discharged ${istDateTime.format(new Date(header.dischargedAt))}`
        : ''
    }`,
    { muted: true },
  );

  for (const section of sections) {
    if (section.text.trim().length === 0) continue;

    sheet.heading(section.label);
    sheet.line(section.text.trim());
  }

  sheet.heading('Signed');
  sheet.line(`${header.signedBy} · ${istDateTime.format(header.signedAt)}`);

  sheet.footer(`Discharge summary · ${header.patientName} · ${header.hospitalName}`);

  return doc.save();
}
