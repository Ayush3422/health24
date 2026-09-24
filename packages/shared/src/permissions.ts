import type { StaffRole } from './enums.js';

/**
 * The permission matrix.
 *
 * This is the single source of truth for who can do what. The API enforces it;
 * the clients read it to decide what to render. Defining it once means the UI
 * can never offer an action the server will refuse, and — more importantly —
 * the reverse can never quietly happen either.
 *
 * Permissions are coarse and few on purpose. A configurable permission system
 * in a clinical product is a liability: once it is configurable, nobody can
 * answer "who can see this patient's record?" without reading a database.
 */
export const PERMISSIONS = [
  // Tenancy
  'hospital:create',
  'hospital:read:any',
  'hospital:read:own',
  'hospital:update:any',
  'hospital:update:own',

  // Staff
  'staff:invite',
  'staff:read',
  'staff:update',
  'staff:deactivate',

  // Patient registry
  'patient:create',
  'patient:read',
  'patient:search',
  'patient:update',
  /** Search across hospitals for an existing person, before creating a duplicate. */
  'patient:lookup_global',

  // Duplicate resolution
  'merge:read',
  'merge:resolve',

  // Audit
  'audit:read:own_hospital',
  'audit:read:any',

  // Terminology
  'terminology:read',
  /** Propose, approve and reject NAMASTE ↔ ICD-11 mappings. */
  'terminology:curate',
  /** Activate and retire terminology releases. */
  'terminology:manage',

  // Clinical record
  /** Encounters, diagnoses, prescriptions and allergies: the hospital's own, and others' under consent. */
  'clinical:read',
  /** Open encounters and record clinical entries at the caller's own hospital. */
  'clinical:write',
  /** Enter clinical data on behalf of a named clinician of the same hospital. */
  'clinical:transcribe',

  // Consent
  /** See the consents this hospital holds for a patient. */
  'consent:read',
  /** Record a patient's consent, given in person, and revoke it. */
  'consent:record',
  /** Take emergency access to a patient's history without consent. */
  'consent:break_glass',
  /** Review emergency accesses taken at this hospital. */
  'consent:review',

  // Documents and results (SP4)
  /** Upload reports and scans, and see the list of what was uploaded. Opening one needs `clinical:read`. */
  'documents:upload',
  /** Type lab results from a report against the curated panels. */
  'results:enter',
  /**
   * Import a legacy paper folder and classify its pages into documents
   * (Decision E1). Classifying means looking at every page, so only roles
   * that read clinical records hold it.
   */
  'documents:import',

  // Patient portal (SP5)
  /** Activate and revoke a patient's portal access, with the patient in front of you (Decision J1). */
  'portal:activate',
  /**
   * Link a child's record to a guardian's phone, after checking the relationship
   * and a document that shows it (Decision M1).
   */
  'portal:link_guardian',

  // Orders (SP6)
  /** Order a test, an image or a procedure, and cancel one (Decision O1). */
  'orders:place',
  /** Move an order along as the work is done: sample collected, study in progress. */
  'orders:fulfil',

  // Wards, beds and admission (SP6, Decision P1)
  /** Set up the hospital's wards and beds, and take a bed out of service. */
  'wards:manage',
  /** Admit a patient to a bed, move them, and discharge them. */
  'admission:manage',

  // The patient's rights under the DPDP Act (SP5)
  /** Review erasure requests and record what was erased and what law requires kept (Decision N1). */
  'privacy:review',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Available to every authenticated staff member regardless of role. */
const BASELINE: Permission[] = [];

/**
 * Note what platform_admin does NOT have: any permission touching patients,
 * or the right to approve a mapping. Health24 staff operate the platform; they
 * neither read patient records nor exercise clinical judgement over what a
 * traditional diagnosis corresponds to. Both are enforced here rather than
 * trusted to discipline.
 */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  platform_admin: [
    ...BASELINE,
    'hospital:create',
    'hospital:read:any',
    'hospital:update:any',
    'audit:read:any',
    'terminology:read',
    'terminology:manage',
  ],

  /**
   * Curators review mappings for the whole platform. They see terminology and
   * nothing else — no hospitals, no staff, no patients.
   */
  terminology_curator: [...BASELINE, 'terminology:read', 'terminology:curate'],

  hospital_admin: [
    ...BASELINE,
    'hospital:read:own',
    'hospital:update:own',
    'staff:invite',
    'staff:read',
    'staff:update',
    'staff:deactivate',
    'audit:read:own_hospital',
    'merge:read',
    'merge:resolve',
    // Reviewing emergency access is oversight, not clinical reading: the queue
    // shows the MRN, the reason and the clinician, never the record itself.
    'consent:review',
    // Wards and beds are the hospital's own furniture, not a clinical record.
    'wards:manage',
  ],

  /**
   * Clinicians can register patients. In a single-practitioner Ayurvedic clinic
   * the doctor is also the front desk; a system that forbids this is a system
   * they abandon.
   */
  clinician: [
    ...BASELINE,
    'hospital:read:own',
    'patient:create',
    'patient:read',
    'patient:search',
    'patient:update',
    'patient:lookup_global',
    'terminology:read',
    'clinical:read',
    'clinical:write',
    'consent:read',
    'consent:record',
    'consent:break_glass',
    'documents:upload',
    'results:enter',
    // A single-doctor clinic has no records staff to import its old files.
    'documents:import',
    'portal:activate',
    'orders:place',
    'orders:fulfil',
    'admission:manage',
  ],

  front_desk: [
    ...BASELINE,
    'hospital:read:own',
    'patient:create',
    'patient:read',
    'patient:search',
    'patient:update',
    'patient:lookup_global',
    'merge:read',
    'merge:resolve',
    'consent:read',
    'consent:record',
    // Uploads and types results from the report in hand; does not open reports
    // afterwards, which is reading clinical records (Decision H1).
    'documents:upload',
    'results:enter',
    // The desk sees the patient in person, which is what activation rests on.
    'portal:activate',
    'portal:link_guardian',
    // Takes the sample and marks the study under way; never decides what to order.
    'orders:fulfil',
    // The desk admits, moves and discharges: it is who holds the bed board.
    'admission:manage',
  ],

  /**
   * Records staff transcribe from the doctor's file. They read clinical data
   * and enter it in a named clinician's name, never their own — so every
   * diagnosis and prescription still belongs to a doctor. They do not stop
   * medicines: that is a fresh clinical decision, not transcription.
   */
  medical_records: [
    ...BASELINE,
    'hospital:read:own',
    'patient:create',
    'patient:read',
    'patient:search',
    'patient:update',
    'patient:lookup_global',
    'merge:read',
    'merge:resolve',
    'terminology:read',
    'clinical:read',
    'clinical:transcribe',
    'consent:read',
    'consent:record',
    'documents:upload',
    'results:enter',
    'documents:import',
    'portal:activate',
    'portal:link_guardian',
    // Transcribes an order from the doctor's file, in that doctor's name.
    'orders:place',
    'orders:fulfil',
  ],

  /**
   * The data-protection officer decides erasure requests and records the
   * outcome. Nothing else: reviewing a request never means reading the record
   * it is about.
   */
  data_protection_officer: [...BASELINE, 'privacy:review'],
};

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: StaffRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
