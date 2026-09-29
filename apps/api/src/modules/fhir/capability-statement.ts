/**
 * What this FHIR surface says it can do — and, at greater length, what it
 * cannot (sp8-plan.md, T26, DF10, DF11).
 *
 * A `CapabilityStatement` is a promise made to a machine. Clients read it and
 * then assume; so the interactions listed here are exactly the ones that are
 * routed, and a test asserts that in both directions — nothing claimed that
 * is not served, nothing served that is not claimed.
 *
 * The `documentation` strings are for the person reading it when something
 * does not work. They say the awkward things rather than leaving a client to
 * discover them: this surface is **read-only**, clinical searches are
 * **patient-scoped and require it**, and conformance to ABDM's published
 * profiles is **not claimed**.
 */

export const FHIR_VERSION = '4.0.1';
export const FHIR_BASE = '/fhir/R4';

/**
 * The paths kept out of the `/api/v1` prefix.
 *
 * A FHIR client is given a base URL and expects `{base}/Patient/{id}` to
 * work; versioning it twice would mean two version numbers that can
 * disagree. A test asserts that every route this surface serves is under
 * this base, so the exclusion cannot silently stop covering a new one.
 */
export const FHIR_ROUTES = ['fhir/R4', 'fhir/R4/(.*)'];

export interface FhirResourceSupport {
  type: string;
  /** The search parameters this surface actually reads. */
  searchParams: Array<{ name: string; type: string; documentation: string }>;
  /** True when a search must name a patient. */
  patientScoped: boolean;
  documentation: string;
}

export const FHIR_RESOURCES: FhirResourceSupport[] = [
  {
    type: 'Patient',
    patientScoped: false,
    searchParams: [
      { name: '_id', type: 'token', documentation: 'This system’s patient id.' },
      {
        name: 'identifier',
        type: 'token',
        documentation:
          'An ABHA number, an ABHA address, or a medical record number at the calling hospital.',
      },
    ],
    documentation:
      'Scoped to the calling hospital by the database: a patient this hospital has never seen does not exist here.',
  },
  {
    type: 'Encounter',
    patientScoped: true,
    searchParams: [{ name: 'patient', type: 'reference', documentation: 'Required.' }],
    documentation: 'Visits, including another hospital’s where a consent admits them.',
  },
  {
    type: 'Condition',
    patientScoped: true,
    searchParams: [{ name: 'patient', type: 'reference', documentation: 'Required.' }],
    documentation:
      'Diagnoses, each carrying every coding the record holds — the clinician’s own term and whatever a mapping attached to it.',
  },
  {
    type: 'MedicationRequest',
    patientScoped: true,
    searchParams: [{ name: 'patient', type: 'reference', documentation: 'Required.' }],
    documentation: 'Prescriptions.',
  },
  {
    type: 'Observation',
    patientScoped: true,
    searchParams: [{ name: 'patient', type: 'reference', documentation: 'Required.' }],
    documentation: 'Typed results and vitals.',
  },
  {
    type: 'DocumentReference',
    patientScoped: true,
    searchParams: [{ name: 'patient', type: 'reference', documentation: 'Required.' }],
    documentation:
      'Reports, by name and date. The files themselves are not here: they are fetched one link at a time, and each issue is audited.',
  },
  {
    type: 'CodeSystem',
    patientScoped: false,
    searchParams: [
      { name: '_id', type: 'token', documentation: 'This system’s id for the release.' },
      { name: 'url', type: 'uri', documentation: 'The canonical URL of the code system.' },
    ],
    documentation:
      'NAMASTE and ICD-11 as this system holds them. Metadata only: the concepts are not expanded into the resource, because a release has tens of thousands and nobody wants them in one response.',
  },
  {
    type: 'ConceptMap',
    patientScoped: false,
    searchParams: [
      { name: '_id', type: 'token', documentation: 'This system’s id for the map.' },
      { name: 'url', type: 'uri', documentation: 'The canonical URL of the map.' },
    ],
    documentation:
      'NAMASTE to ICD-11. Metadata only, as CodeSystem; use $translate for a code.',
  },
];

/** What this surface will not do, said once, where a client will read it. */
const LIMITATIONS = [
  'Read-only. There is no create, update, delete, or transaction; the clinical record is written through /api/v1 and nowhere else.',
  'Every clinical search must name a patient. There is no way to ask this surface for all of anything.',
  'No _history, no _include, no _revinclude, no chained parameters.',
  'Conformance to ABDM’s published profiles is not claimed. The resources follow FHIR R4 and the mappings this system uses for a patient’s own export; the deviations are listed in docs/fhir.md.',
  'Clinicians’ notes are not exposed here at all.',
].join(' ');

export function capabilityStatement(now: Date): Record<string, unknown> {
  return {
    resourceType: 'CapabilityStatement',
    id: 'health24-fhir-r4',
    status: 'active',
    date: now.toISOString(),
    kind: 'instance',
    publisher: 'Health24',
    description: LIMITATIONS,
    fhirVersion: FHIR_VERSION,
    format: ['application/fhir+json'],
    rest: [
      {
        mode: 'server',
        documentation: LIMITATIONS,
        security: {
          description:
            'The same bearer token, permissions and row-level security as /api/v1. Nothing is visible here that is not visible there.',
        },
        resource: FHIR_RESOURCES.map((resource) => ({
          type: resource.type,
          // Exactly what is routed. A test asserts this in both directions.
          interaction: [{ code: 'read' }, { code: 'search-type' }],
          searchParam: resource.searchParams.map((parameter) => ({
            name: parameter.name,
            type: parameter.type,
            documentation: parameter.documentation,
          })),
          documentation: resource.documentation,
        })),
        operation: [
          {
            name: 'translate',
            definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-translate',
            documentation:
              'Translates a NAMASTE code to ICD-11 using the active release, and says which mapping it came from and how equivalent it is.',
          },
        ],
      },
    ],
  };
}
