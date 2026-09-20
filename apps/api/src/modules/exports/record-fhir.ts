import type { ExportRecord } from './export-record';

/**
 * The patient's record as a FHIR R4 `Bundle` of type `collection`
 * (sp5-plan.md, Decision N1): Patient, Encounter, Condition,
 * MedicationRequest, AllergyIntolerance, Observation, Procedure and
 * DocumentReference.
 *
 * Doctors' notes are left out: FHIR carries them as DocumentReference with the
 * text attached, and attaching clinical notes to a downloadable bundle is a
 * decision for the clinical reviewer, not a mapping choice. The PDF has them.
 *
 * This is also the first piece of the `/fhir/R4` surface in planning.md §10,
 * so the mappings here are meant to be the ones that surface reuses.
 */

const HOSPITAL = 'urn:health24:hospital';

const reference = (type: string, id: string) => ({ reference: `${type}/${id}` });

const encounterClass: Record<string, { code: string; display: string }> = {
  outpatient: { code: 'AMB', display: 'ambulatory' },
  inpatient: { code: 'IMP', display: 'inpatient encounter' },
  emergency: { code: 'EMER', display: 'emergency' },
  teleconsultation: { code: 'VR', display: 'virtual' },
};

const medicationStatus: Record<string, string> = {
  active: 'active',
  stopped: 'stopped',
  completed: 'completed',
};

const interpretationCode: Record<string, { code: string; display: string }> = {
  high: { code: 'H', display: 'High' },
  low: { code: 'L', display: 'Low' },
  abnormal: { code: 'A', display: 'Abnormal' },
  normal: { code: 'N', display: 'Normal' },
};

export function buildRecordFhir(record: ExportRecord, exportedAt: Date): unknown {
  const patient = {
    resourceType: 'Patient',
    id: record.patient.id,
    identifier: record.hospitals.map((hospital) => ({
      system: `${HOSPITAL}:${hospital.id}`,
      value: hospital.mrn,
    })),
    name: [{ text: record.patient.name }],
    gender: ['male', 'female', 'other'].includes(record.patient.gender)
      ? record.patient.gender
      : 'unknown',
    birthDate: record.patient.dateOfBirth ?? undefined,
    telecom: record.patient.phone
      ? [{ system: 'phone', value: record.patient.phone, use: 'mobile' }]
      : undefined,
    contact:
      record.patient.emergencyContactName && record.patient.emergencyContactPhone
        ? [
            {
              relationship: [{ text: 'Emergency contact' }],
              name: { text: record.patient.emergencyContactName },
              telecom: [{ system: 'phone', value: record.patient.emergencyContactPhone }],
            },
          ]
        : undefined,
  };

  const subject = reference('Patient', record.patient.id);

  const encounters = record.encounters.map((visit) => ({
    resourceType: 'Encounter',
    id: visit.id,
    status: visit.status === 'in_progress' ? 'in-progress' : visit.status,
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      ...(encounterClass[visit.class] ?? { code: 'AMB', display: 'ambulatory' }),
    },
    subject,
    period: { start: visit.started_at, end: visit.ended_at ?? undefined },
    reasonCode: visit.chief_complaint ? [{ text: visit.chief_complaint }] : undefined,
    serviceProvider: visit.hospital_name ? { display: visit.hospital_name } : undefined,
  }));

  const conditions = record.conditions.map((condition) => ({
    resourceType: 'Condition',
    id: condition.id,
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          code: condition.clinical_status,
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
          code: condition.verification_status === 'provisional' ? 'provisional' : 'confirmed',
        },
      ],
    },
    code: {
      coding: condition.codings.map((coding) => ({
        system: coding.system,
        code: coding.code,
        display: coding.display,
      })),
      text: condition.codings.find((coding) => coding.role === 'primary')?.display,
    },
    subject,
    recordedDate: condition.recorded_at,
    note: condition.note ? [{ text: condition.note }] : undefined,
  }));

  const medications = record.medications.map((medicine) => ({
    resourceType: 'MedicationRequest',
    id: medicine.id,
    status: medicationStatus[medicine.status] ?? 'unknown',
    intent: 'order',
    medicationCodeableConcept: {
      text: [medicine.medicine_name, medicine.strength].filter(Boolean).join(' '),
    },
    subject,
    authoredOn: medicine.recorded_at,
    dosageInstruction: [
      {
        text: [medicine.dose, medicine.frequency, medicine.duration, medicine.instructions]
          .filter(Boolean)
          .join(' · '),
        route: { text: medicine.route },
      },
    ],
  }));

  const allergies = record.allergies.map((allergy) => ({
    resourceType: 'AllergyIntolerance',
    id: allergy.id,
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
          code: allergy.clinical_status,
        },
      ],
    },
    category: [allergy.category === 'medication' ? 'medication' : allergy.category],
    criticality: allergy.criticality === 'unable_to_assess' ? 'unable-to-assess' : allergy.criticality,
    code: { text: allergy.substance },
    patient: subject,
    recordedDate: allergy.recorded_at,
    reaction: allergy.reaction ? [{ manifestation: [{ text: allergy.reaction }] }] : undefined,
  }));

  const observations = record.observations.map((observation) => ({
    resourceType: 'Observation',
    id: observation.id,
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: observation.category === 'laboratory' ? 'laboratory' : 'vital-signs',
          },
        ],
      },
    ],
    code: {
      coding: [
        { system: observation.code_system, code: observation.code, display: observation.display },
      ],
      text: observation.display,
    },
    subject,
    effectiveDateTime: observation.effective_at,
    valueQuantity:
      observation.value !== null
        ? { value: Number(observation.value), unit: observation.unit ?? undefined }
        : undefined,
    valueString: observation.value === null ? (observation.value_text ?? undefined) : undefined,
    interpretation:
      observation.interpretation && interpretationCode[observation.interpretation]
        ? [
            {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                  ...interpretationCode[observation.interpretation],
                },
              ],
            },
          ]
        : undefined,
    referenceRange:
      observation.reference_low || observation.reference_high
        ? [
            {
              low: observation.reference_low
                ? { value: Number(observation.reference_low), unit: observation.unit ?? undefined }
                : undefined,
              high: observation.reference_high
                ? { value: Number(observation.reference_high), unit: observation.unit ?? undefined }
                : undefined,
            },
          ]
        : undefined,
  }));

  const procedures = record.procedures.map((procedure) => ({
    resourceType: 'Procedure',
    id: procedure.id,
    status: 'completed',
    code: { text: procedure.name },
    subject,
    performedDateTime: procedure.performed_at,
    outcome: procedure.outcome ? { text: procedure.outcome } : undefined,
  }));

  const documents = record.documents.map((document) => ({
    resourceType: 'DocumentReference',
    id: document.id,
    status: 'current',
    type: { text: document.doc_type.replace(/_/g, ' ') },
    subject,
    date: document.report_date,
    description: document.title ?? undefined,
    custodian: document.hospital_name ? { display: document.hospital_name } : undefined,
    // The files themselves are downloaded from the portal, through links issued
    // one at a time and audited; a bundle never carries a long-lived link.
    content: [{ attachment: { title: `${document.file_count} file(s) in the Health24 portal` } }],
  }));

  const resources = [
    patient,
    ...encounters,
    ...conditions,
    ...medications,
    ...allergies,
    ...observations,
    ...procedures,
    ...documents,
  ];

  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: exportedAt.toISOString(),
    total: resources.length,
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${(resource as { id: string }).id}`,
      resource,
    })),
  };
}
