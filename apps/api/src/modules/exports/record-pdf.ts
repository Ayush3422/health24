import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { ExportRecord } from './export-record';
import { day, istDateTime, join, moment, Sheet } from './pdf-sheet';

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
