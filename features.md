# Health24 — Feature Catalogue

**Status:** Proposal for review. Companion to `planning.md`.
**Last updated:** 2026-09-12

Every feature is tagged with the sub-project that delivers it (SP1–SP6, defined in `planning.md` §4) and the user role it serves.

Roles: **C** = clinician · **F** = front-desk · **R** = medical records staff · **P** = patient · **A** = hospital admin · **X** = platform admin

---

## 0. The seven features that are the product

Everything else in this document is table stakes — necessary, but any EHR has it. These seven are why Health24 exists. If a trade-off has to be made, it is made in favour of these.

| #   | Feature                                                                                          | Why it matters                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Dual-coded diagnosis** — clinician records in their own vocabulary, record is readable in both | The core promise. No other Indian EHR does this.                                                                                                                                   |
| 2   | **Cross-hospital unified timeline**                                                              | The patient stops being the integration layer                                                                                                                                      |
| 3   | **Cross-system allergy and formulation visibility**                                              | The safety case. An allopath prescribing without knowing the patient's current Ayurvedic formulations is the risk this product removes                                             |
| 4   | **Reverse lookup** — allopath records ICD-11, sees the traditional equivalent                    | Makes the bridge two-way. Ayurvedic doctors gain as much as physicians                                                                                                             |
| 5   | **Lab trends across hospitals**                                                                  | Same analyte, five hospitals, one graph. Impossible on paper                                                                                                                       |
| 6   | **Emergency QR card**                                                                            | Allergies, blood group, active medications, scannable by any casualty department                                                                                                   |
| 7   | **Automatic statutory morbidity reporting**                                                      | Coded data means Ayush facilities generate their Ministry returns from real records instead of hand-tallying. This is the feature that sells the system to hospital administrators |

Feature 7 deserves emphasis: it converts your compliance burden into the hospital's compliance _relief_. It is likely your strongest commercial argument, and it costs little once SP2 and SP3 exist.

---

## SP1 — Foundation

### Platform administration (X)

- Hospital onboarding: create tenant, facility type (allopathic / Ayush / integrated), HFR ID, address, contact
- Hospital status control: active, suspended, offboarded
- Platform-wide audit log access
- Terminology release management (publish a new NAMASTE / ICD-11 version)

### Hospital administration (A)

- Staff invite and lifecycle: create, deactivate, reinstate
- Role assignment from a fixed role set
- Record HPR ID and system of medicine per clinician
- Department / unit setup
- Hospital-level audit log: who accessed which patient, when, under what consent
- Hospital profile and letterhead settings (used on printed prescriptions and summaries)

### Authentication and access (all)

- Phone or email sign-in with password
- OTP verification at registration and on new device
- TOTP multi-factor, mandatory for clinicians and admins
- Session list with remote sign-out
- Password policy, lockout on repeated failure
- Role-based permission enforcement, server-side
- Postgres row-level tenant isolation

### Patient registry (F, C)

- Patient registration: name, DOB, gender, phone, address, emergency contact, photo
- ABHA number / address capture and verification (optional at v1)
- Automatic MRN generation, per hospital, configurable format
- Patient search within hospital: name, phone, MRN, ABHA
- Global patient lookup — find a person already registered at another hospital
- Deterministic ABHA matching; probabilistic matching on phone + DOB + name
- Duplicate review queue for uncertain matches (F, A)
- Reversible merge with full merge log
- Patient demographic edit with change history

---

## SP2 — Terminology

### Ingestion and maintenance (X)

- NAMASTE code set import (Ayurveda, and later Siddha and Unani), versioned and idempotent
- ICD-11 TM2 and MMS synchronisation via the WHO ICD API
- LOINC subset import for the supported lab panel
- Release diff view: what changed between two versions
- Nothing is ever mutated in place — a new release writes new versioned rows

### Search and browse (C)

- Script-aware search: **अम्लपित्त**, `amlapitta`, and `Amlapitta` all reach the same concept
- Synonym and transliteration tolerance
- Typo tolerance via trigram similarity
- Ranked results: exact → prefix → fuzzy → frequency of use
- Concept browser with hierarchy, definitions, and parent/child navigation
- Recently used and favourite concepts per clinician

### Mapping (C, X)

- Concept map storage with equivalence strength (equivalent / wider / narrower / inexact / unmatched) and confidence
- Translate API: given a code, return its equivalents in the other systems
- Auto-coding service used at diagnosis entry
- **Curation console (X):** review queue, approve / edit / reject a mapping, with reviewer attribution and timestamp
- Mapping coverage dashboard: what percentage of NAMASTE concepts have a TM2 mapping, and an MMS one
- "No biomedical equivalent recorded" as a normal, displayable state — not an error

---

## SP3 — Clinical record

### Records staff entry (R) — decided 2026-09-13

- Enter encounters, diagnoses, prescriptions, allergies and other documentation from a doctor's file, **on behalf of a named clinician** of the same hospital
- Every transcribed entry shows who typed it and whose clinical decision it is
- Same safety checks as direct entry, including the allergy check at prescribing

### Encounters (C, F)

- Start an encounter: OPD, IPD, emergency, teleconsultation
- System of medicine recorded on every encounter
- Attending clinician, department, chief complaint
- Encounter status: open, closed, amended

### Diagnosis — the centrepiece (C)

- Search and select in the clinician's own vocabulary
- On selection, the system silently attaches the ICD-11 TM2 code and, where the mapping is strong enough, an advisory biomedical code
- All three codings shown in the entry UI, clearly distinguished, with the advisory one visibly labelled as a suggested correspondence rather than a diagnosis
- Clinician may override or remove any auto-attached code; the override is logged
- **Reverse direction:** an allopathic clinician selects an ICD-11 code and sees the traditional equivalent
- Primary vs secondary diagnosis
- Clinical status: active, resolved, recurrence
- Onset date, free-text qualifier
- **Problem list:** every active condition across every hospital, in one place

### Prescriptions (C)

- Ayurvedic prescription: formulation, dose, _anupana_ / vehicle, timing relative to food, duration, special instructions
- Allopathic prescription: drug, strength, frequency, route, duration
- Both render on one medication list, visually separated by system
- **Current medications view** — what the patient is on right now, from every hospital
- Allergy check against recorded allergies at the point of prescribing
- Printable / PDF prescription on hospital letterhead
- Stop, modify, or continue an existing medication

### Safety (C, F)

- Allergy and intolerance recording: substance, reaction, criticality
- Persistent allergy banner on every clinical screen for that patient
- Adverse reaction recording

### Other clinical documentation (C)

- Vitals: BP, pulse, temperature, SpO₂, height, weight, BMI
- Clinical notes, with reusable templates per department
- Procedures and therapies — surgical procedures and Panchakarma therapies use the same model
- Follow-up advice and next visit date

### The timeline (C, P)

- Single chronological stream of everything: encounters, diagnoses, prescriptions, procedures, reports, labs
- Hospital and system of medicine visually distinguished
- Filter by category, date range, hospital, or system
- Vocabulary rendered according to who is reading — an allopath sees ICD-11 first, a vaidya sees NAMASTE first
- **Patient summary card:** the thirty-second view — active problems, current medications, allergies, recent abnormal labs, last three encounters
- Referral / handoff view: a shareable summary for sending a patient onward

### Record integrity (all)

- Clinical data is never hard-deleted
- Amendments create a new version; the original remains and is viewable
- Every read and write is logged to the append-only audit trail

---

## SP4 — Documents and results

### Documents (F, C, P)

- Upload reports: drag-and-drop, multi-file, and mobile camera capture for scanning paper
- Document type taxonomy: lab report, radiology, discharge summary, prescription, operative note, referral, other
- Metadata: report date, ordering clinician, performing facility
- Inline viewer for PDF and images, with zoom
- Thumbnail previews
- Search and filter by type, date, hospital
- **Bulk import of legacy paper files** — the feature that actually gets a hospital's existing archive into the system
- Virus scanning on every upload
- Download, and consented sharing

### Structured results (F, C, P)

- Manual entry of numeric results against a curated LOINC panel (CBC, LFT, KFT, lipid profile, HbA1c, TSH, fasting and post-prandial glucose)
- Reference ranges with automatic abnormal flagging
- **Trend graphs per analyte, across all hospitals and all time**
- Results attached to their source document
- `source` field distinguishes typed values from later machine-extracted ones

---

## SP5 — Patient portal and consent

### Patient account (P)

- Sign-up and sign-in with phone number and OTP; no patient password (decided 2026-09-13)
- ABHA linking
- Own longitudinal timeline, rendered in plain language rather than clinical shorthand
- Download any report
- Current medications and active problems

### Consent (P)

- Grant a hospital access to history from other hospitals
- Granularity by data category, date range, and expiry
- Revoke at any time, with immediate effect
- Consent history: every grant and revocation, timestamped
- **Access history:** who looked at my record, when, and under what authority
- Notification when a break-glass emergency access occurs on the account

### Emergency (P, C)

- **Emergency QR card:** blood group, allergies, active medications, emergency contact, chronic conditions — readable by any casualty department without login
- Printable wallet card and phone lock-screen image

### Family (P)

- Link dependants: children, elderly parents
- Manage a dependant's record and consents
- Age-based automatic transition of control to the dependant at adulthood

### Rights under DPDP (P)

- Export the complete record (FHIR bundle and human-readable PDF)
- Request correction of demographic data
- Request erasure, handled through a documented workflow with clinical-retention exceptions

---

## SP6 — Operations

### Orders (C, F)

- Test and imaging order entry
- Order status tracking: ordered, collected, in progress, resulted
- Result linked back to the originating order

### Inpatient and surgery (C, F)

- Admission, transfer, discharge
- Bed and ward assignment
- Surgery record: pre-operative assessment, operative note, implants and devices, post-operative course
- **Auto-composed discharge summary** assembled from the encounter's own data, editable before sign-off

### Billing (F, A)

- Service and procedure catalogue with pricing
- Charge capture from orders and procedures
- Invoice generation, itemised
- Payments, part-payments, refunds
- Insurance and scheme fields (PM-JAY, private insurers) — capture only; adjudication is out of scope
- Outstanding dues report

### Reporting and analytics (A, X)

- Patient footfall by department, clinician, and period
- **Diagnosis distribution using coded data — statutory Ayush morbidity returns generated automatically**
- Prescription patterns
- Revenue summaries
- Data-quality report: unmapped diagnoses, incomplete records

---

## Cross-cutting

- **Notifications** — SMS and WhatsApp for OTP, appointment reminders, report-ready alerts, consent requests
- **Printing** — every clinical artefact prints on hospital letterhead; Indian hospitals run on paper alongside screens for years
- **Internationalisation** — UI language and clinical display language handled separately from day one, even if v1 ships English-only
- **Full-text search** across a patient's own records
- **Keyboard-first clinical entry** — clinicians work fast; every high-frequency action needs a shortcut
- **Accessibility** — WCAG 2.2 AA on the patient portal

---

## Deliberately excluded

| Excluded                                                     | Reason                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clinical decision support, diagnosis or treatment suggestion | Changes the regulatory category; the system reports, it does not advise                                                                            |
| Drug–drug and drug–herb interaction checking                 | Genuinely valuable and genuinely dangerous to get wrong. Needs a licensed interaction database and clinical governance. Revisit as its own project |
| Pharmacy stock, inventory, HR, payroll                       | Hospital ERP territory                                                                                                                             |
| Insurance claim adjudication                                 | Separate domain; NHCX integration is a later sub-project                                                                                           |
| Video consultation                                           | Commodity; integrate a third party if ever needed                                                                                                  |
| Appointment booking and queue management                     | Common, but not differentiating. Add only if a pilot hospital demands it                                                                           |
| OCR extraction of report values                              | Deferred to a later sub-project. The `source` field exists now so it can be added without redesign                                                 |

---

## Open feature decisions

1. **Offline tolerance.** Many Indian hospitals have unreliable connectivity. A cloud-only clinical system that stops working during an outage gets abandoned within a month. Options: accept it, build a read-only local cache of today's patients, or build full offline-first sync. Full offline-first roughly doubles the client complexity. **This needs a decision before SP3 begins** — it is not retrofittable.
2. **Appointment booking** — include, or leave to the hospital's existing system?
3. **Ayurvedic formulation vocabulary** — is there a coded catalogue to adopt, or must Health24 build one? Prescriptions currently have no coding story. (Also `planning.md` §15 Q7.)
4. **Nurse as a distinct role** — vitals and medication administration are nursing work in IPD. Currently folded into front-desk and clinician roles.
5. **Patient-generated data** — home BP, glucose readings. Cheap to add, and it makes the portal something patients open more than twice a year.
