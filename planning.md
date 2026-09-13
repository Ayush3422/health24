# Health24 — Unified Patient Record System with NAMASTE + ICD-11 Dual Coding

**Status:** Planning. No implementation has begun.
**Last updated:** 2026-09-08
**Author:** ayush

---

## 0. How to read this document

Sections 1–5 record decisions already made and agreed. Sections 6–14 are **proposals awaiting your review** — they were written ahead so you can review the whole system at once rather than section by section. Section 15 lists the questions I still need answered, and Section 16 the risks I think are real.

Nothing here is built. Implementation starts only after you approve.

---

## 1. Problem statement

Indian healthcare records are fragmented in two directions at once.

**Horizontally**, across institutions: a patient's history lives in paper files, each hospital holding a disconnected fragment. When the patient walks into a new hospital, that history is reconstructed from memory — unreliably, and under time pressure.

**Vertically**, across systems of medicine: a patient treated by an Ayurvedic practitioner and later by an allopathic physician has two records that cannot be read by each other. The Ayurvedic record uses vocabulary the physician does not know; the physician's record uses vocabulary the vaidya does not know. The patient becomes the only integration layer, and they are the least equipped party to be it.

The second gap is the one nobody has solved, and it is this project's reason to exist.

### The scenario the system must serve

A patient is treated for _Amlapitta_ by an Ayurvedic doctor for four months. Results are unsatisfactory. They consult a gastroenterologist. Today, that physician starts from zero — and does not learn what formulations the patient has been taking, which matters both diagnostically and for interaction safety.

With Health24, the physician opens the patient's timeline and sees: the diagnosis, rendered in _their_ vocabulary (ICD-11); the exact formulations prescribed, with dates and durations; the tests already run and their values; and the reports already taken. The patient explains nothing.

---

## 2. Goals and non-goals

### Goals

- One longitudinal patient record spanning every participating hospital.
- Every diagnosis carries codes in both traditional (NAMASTE) and international (ICD-11 TM2, and where defensible ICD-11 MMS) vocabularies.
- Reading a record never requires knowing the vocabulary it was written in.
- Full replacement of the paper file: notes, prescriptions, reports, orders, procedures, and bills.
- Consent is real and patient-controlled, not a checkbox.
- Every access to a patient record is logged and answerable to the patient.

### Non-goals (explicitly out of scope, possibly forever)

- Clinical decision support, diagnosis suggestion, or treatment recommendation. The system reports; it does not advise. This is a deliberate line — crossing it changes the regulatory category of the product.
- Replacing hospital ERP, HR, inventory, or pharmacy stock management.
- Insurance claim adjudication (PM-JAY / NHCX integration is a possible later sub-project, not part of this system's core).
- Telemedicine video consultation.
- Being a certified medical device under CDSCO. Nothing in the design should drift toward that classification without a deliberate decision.

---

## 3. Decisions already made

| #   | Decision                                                                | Rationale                                                                                                                                                 |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Real product for hospitals, not a prototype                             | Sets the compliance and security bar from day one                                                                                                         |
| D2  | Central multi-tenant cloud; Health24 holds the data                     | Fastest path to the cross-hospital value; accepts Data Fiduciary obligations                                                                              |
| D3  | ABDM-federated architecture deferred, not abandoned                     | Data modelled FHIR-shaped from the start so HIP/HIU adapters are additive                                                                                 |
| D4  | Clinician selects NAMASTE; system auto-attaches ICD-11 codes            | Zero extra work for the practitioner; one entry, three codings                                                                                            |
| D5  | TM2 mapping authoritative; biomedical (MMS) mapping advisory only       | NAMASTE→TM2 is curated; NAMASTE→MMS is frequently not a clean equivalence                                                                                 |
| D6  | Four user families: clinicians, front-desk/records, patients, admins    | Two app surfaces on one API                                                                                                                               |
| D7  | Reports stored as files **and** key results as LOINC-coded observations | Enables cross-hospital trend graphs — a second real differentiator                                                                                        |
| D8  | Custom relational schema, FHIR-shaped, translated at the API edge       | Normal SQL for the timeline query; FHIR without FHIR's per-screen tax                                                                                     |
| D9  | TypeScript end to end                                                   | Solo developer; shared types between server and clients                                                                                                   |
| D10 | `allergy_intolerance` and `system_of_medicine` included in v1           | Cross-system care without allergy visibility is worse than paper                                                                                          |
| D11 | Records staff enter clinical data on behalf of a named clinician        | Hospitals transcribe from paper; every entry records who typed it and whose clinical decision it is. Admins still never read records (decided 2026-09-13) |
| D12 | Patients sign in with phone number and OTP, no password                 | Every patient has a phone; nobody forgets an OTP. SMS provider needed for production (decided 2026-09-13)                                                 |

### Approaches considered and rejected

**Full FHIR server (HAPI FHIR / Medplum).** Genuinely tempting: instant standards compliance, auth and access policies included, ABDM far closer. Rejected because FHIR's complexity leaks into every screen — a simple timeline becomes several resource queries — and because it couples the most critical part of the system to an external roadmap. Revisit if ABDM certification becomes urgent.

**Document store / EAV clinical model.** Rejected. The core value is querying _across_ records — every event, every hospital, ordered, filtered by code. That is a relational problem, and unstructured clinical data degrades quickly without schema enforcement.

---

## 4. Scope decomposition

The full vision is not one project. It is six, and they must be built in order.

| #   | Sub-project                  | Contains                                                               |
| --- | ---------------------------- | ---------------------------------------------------------------------- |
| SP1 | **Foundation**               | Tenancy, identity, auth, patient registry, audit skeleton              |
| SP2 | **Terminology service**      | NAMASTE + ICD-11 ingestion, search, concept maps, translate API        |
| SP3 | **Clinical record**          | Encounters, dual-coded conditions, prescriptions, procedures, timeline |
| SP4 | **Documents & results**      | Report upload/storage, LOINC observations, trend views                 |
| SP5 | **Patient portal & consent** | Patient login, consent grant/revoke, access history                    |
| SP6 | **Operations**               | Orders, surgery detail, billing, reporting                             |

SP1 + SP2 + SP3 together constitute the minimum system that delivers the core promise. SP4–SP6 are additive on the same encounter model and require no redesign.

Each sub-project gets its own detailed implementation plan before its code is written.

---

## 5. Architecture

### 5.1 Module decomposition

Seven modules. Each owns its tables, exposes a service interface, and never reads another module's tables directly.

| Module                   | Owns                                                                                  | Depends on            |
| ------------------------ | ------------------------------------------------------------------------------------- | --------------------- |
| 1. Identity & Access     | hospitals (tenants), staff accounts, patient accounts, sessions, roles                | —                     |
| 2. Patient Registry      | patient identity, ABHA linkage, per-hospital MRN mapping, duplicate detection & merge | Identity              |
| 3. Terminology           | code systems, concepts, designations, concept maps, search, translate                 | —                     |
| 4. Clinical Records      | encounters, conditions, prescriptions, procedures, observations                       | Registry, Terminology |
| 5. Documents             | uploads, object storage, retrieval, encounter linking                                 | Registry              |
| 6. Consent & Audit       | consent artefacts, access enforcement, append-only access log                         | Identity, Registry    |
| 7. Timeline (read model) | the composed cross-hospital patient view                                              | 4, 5, 6               |

Two boundaries carry unusual weight:

**Terminology has zero foreign keys into clinical data.** Clinical rows store `(code_system, code)` string pairs, never terminology row IDs. Consequence: a NAMASTE or ICD-11 release can be ingested, versioned, or rebuilt without touching a single clinical record, and the module can later be extracted into its own deployable. This is the most important boundary in the system.

**Timeline is a materialised read model, not a live join.** The cross-hospital timeline is the product. Composing it at request time across six tables × N hospitals × consent filtering will not stay fast or maintainable. It gets a denormalised, consent-filtered projection, rebuilt on write.

### 5.2 Deployment shape

A single deployable API (modular monolith) plus two frontend builds. Not microservices — a solo developer running six services spends their time on operations instead of product. The module boundaries above are enforced in code (directory structure, no cross-module imports except through service interfaces), so extraction later is mechanical if it is ever needed.

---

## 6. Data model

### 6.1 Tenancy and identity

```
hospital               id, name, facility_type(allopathic|ayush|integrated),
                       abdm_hfr_id, address, status
staff_user             id, hospital_id, name, phone, email, role,
                       hpr_id, system_of_medicine, status
patient                id, abha_number?, abha_address?, name, dob,
                       gender, phone, address, created_by_hospital_id
patient_hospital_link  patient_id, hospital_id, mrn, first_seen_at
patient_account        id, patient_id, phone, credentials, status
```

`patient_hospital_link` exists because the same human carries a different medical record number at every hospital. The global `patient.id` is the spine; each hospital continues to see its own MRN in its own UI. Without this, hospitals reject the system immediately.

### 6.2 The identity-matching problem

Two hospitals will register the same person. ABHA resolves this cleanly when the patient has one; many will not.

Design:

- Deterministic match on ABHA number → automatic link.
- Probabilistic match on (phone, DOB, name similarity, gender) → scored.
- Above a high confidence threshold → link, logged.
- Below it → `patient_merge_candidate` queue for human review.
- Every merge writes to `patient_merge_log` and is reversible.

Auto-merging on fuzzy name matching is how a system hands one person's history to another. Anything uncertain goes to a human.

### 6.3 Clinical core

```
encounter            id, patient_id, hospital_id, class(OPD|IPD|ER|tele),
                     system_of_medicine, attending_staff_id,
                     started_at, ended_at, chief_complaint, status
condition            id, encounter_id, patient_id, clinical_status,
                     onset_date, is_primary, recorded_by, recorded_at
condition_coding     condition_id, code_system, code, display,
                     role(primary|translated|advisory),
                     concept_map_id?, confidence, asserted_by(human|auto)
medication_request   id, encounter_id, patient_id, medication_code,
                     system_of_medicine, dose, frequency, route, duration,
                     vehicle/anupana?, instructions, prescriber_id
procedure            id, encounter_id, code, performed_at, outcome, notes
service_request      id, encounter_id, code, status
observation          id, patient_id, encounter_id?, loinc_code, value, unit,
                     ref_range, effective_at, source(entered|extracted)
allergy_intolerance  id, patient_id, substance_code, criticality, recorded_by
document_reference   id, patient_id, encounter_id?, doc_type, title,
                     storage_key, mime, size, uploaded_by, report_date
```

`condition_coding` as a separate table — rather than three code columns on `condition` — is what makes dual coding clean. One diagnosis carries N codings, each labelled with why it is there: the clinician's own NAMASTE selection (`primary`), the mapped TM2 code (`translated`), and the biomedical suggestion (`advisory`, with confidence). Adding SNOMED CT later is a new row, not a migration.

`system_of_medicine` appears on encounter, prescription, and staff so the timeline can separate traditional from biomedical care visually, without inference.

### 6.4 Consent and audit

```
consent_artefact  id, patient_id, grantee_hospital_id, purpose,
                  data_categories[], date_range_from/to, granted_at,
                  expires_at, revoked_at, status
access_log        actor_id, actor_type, patient_id, resource_type,
                  resource_id, action, consent_artefact_id?,
                  break_glass_reason?, at, ip, user_agent
```

`access_log` records **reads**, not only writes. For PHI that is the requirement, and it is what lets a patient ask who has looked at their file — which under the DPDP Act they may. The table is append-only: no UPDATE or DELETE grant exists for the application role, ever.

---

## 7. Terminology service (the differentiator)

### 7.1 Source vocabularies

| System         | Source                                                                                    | Role                                                           |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **NAMASTE**    | Ministry of Ayush NAMASTE portal — standardised terminologies for Ayurveda, Siddha, Unani | What the traditional practitioner selects                      |
| **ICD-11 TM2** | WHO ICD-11, Traditional Medicine Module 2                                                 | Authoritative international rendering of traditional diagnoses |
| **ICD-11 MMS** | WHO ICD-11 Mortality & Morbidity Statistics linearisation                                 | Biomedical rendering (advisory)                                |
| **LOINC**      | Regenstrief                                                                               | Lab and observation codes                                      |
| **SNOMED CT**  | India holds a national licence via NRCeS                                                  | Optional later; clinical findings                              |

> **To verify before implementation:** exact NAMASTE release version, concept counts, distribution format, and licensing terms for commercial redistribution. ICD-11 API access requires registration with WHO; confirm the terms that apply to a commercial product.

### 7.2 Internal model (FHIR-shaped)

```
code_system           id, uri, name, version, publisher, released_at
concept               id, code_system_id, code, display, definition,
                      parent_code, status
concept_designation   concept_id, language, value, use
                      (Devanagari / Tamil / Arabic script, IAST
                       transliteration, English gloss, synonyms)
concept_map           id, source_system_id, target_system_id, version,
                      publisher, curated_by
concept_map_element   concept_map_id, source_code, target_code,
                      equivalence(equivalent|wider|narrower|inexact|unmatched),
                      confidence, comment, reviewed_by, reviewed_at
```

`concept_designation` matters more than it looks: a vaidya searching for _अम्लपित्त_, `amlapitta`, and `Amlapitta` must all reach the same concept. Search must be script-aware and transliteration-tolerant.

### 7.3 Search

Postgres full-text search plus `pg_trgm` trigram similarity, over designations rather than display names alone. Ranked by exact match → prefix → trigram similarity → usage frequency. Elasticsearch only if Postgres demonstrably fails at real data volume, which at these concept counts is unlikely.

### 7.4 The auto-coding flow

1. Clinician types in their own vocabulary; search returns NAMASTE concepts.
2. Clinician selects one → stored as `condition_coding(role='primary')`.
3. Service looks up NAMASTE→TM2 in `concept_map` → stored as `role='translated'` with equivalence and confidence.
4. Service looks up NAMASTE→MMS → stored as `role='advisory'`, **only if** equivalence is `equivalent` or `wider`; otherwise no biomedical code is attached at all.
5. Every coding records `asserted_by` (human vs auto) and the `concept_map_id` and version used, so any mapping decision is reconstructible years later.

### 7.5 The mapping problem — stated honestly

NAMASTE→TM2 mappings may be available from official sources; NAMASTE→MMS generally are not, and where they exist they are frequently `inexact`. Three consequences that must be designed in, not discovered later:

- Unmapped concepts are normal, not errors. The UI must render "no biomedical equivalent recorded" as an ordinary state.
- Advisory codes must be visually distinct in every clinician view, labelled as a suggested correspondence, never as a diagnosis.
- A curation workflow is required: an internal tool where a qualified reviewer approves, edits, or rejects mappings, with attribution. Mapping quality is the product's clinical credibility; it cannot be crowd-sourced or inferred.

### 7.6 Release management

Vocabularies version. Ingestion is idempotent, versioned, and never mutates existing concepts — a new release creates new rows with a new `version`. Clinical records reference `(system, code, version)`, so a record coded in 2026 still renders correctly after a 2029 release retires that code.

---

## 8. Consent and access control

Three layers, all enforced server-side:

1. **Tenant isolation** — Postgres row-level security. A staff user's queries are scoped to their hospital by the database, not by application `WHERE` clauses. Application bugs then cannot leak across tenants.
2. **Role permissions** — what a role may do within its tenant. Front-desk registers and uploads but does not read clinical notes; clinicians read and write clinical data; medical records staff read clinical data and enter it on behalf of a named clinician (D11); admins manage users and never read records.
3. **Patient consent** — what a hospital may see of a patient's history from _other_ hospitals. Data created by Hospital A is visible to Hospital A; visibility to Hospital B requires an active `consent_artefact`.

**Consent granularity:** by data category (diagnoses / prescriptions / reports / labs), by date range, and time-boxed with an expiry. The default grant at registration is a bounded, explicit choice by the patient, not a silent opt-in.

**Break-glass:** emergency access without prior consent, requiring a typed reason, notifying the patient, and flagging the access for review. Real hospitals need this; unaudited break-glass is how consent systems become decorative.

---

## 9. Documents and lab results

**Storage.** S3-compatible object storage, AWS Mumbai region (data residency). Server-side encryption at rest. No public objects, ever. Access exclusively through short-lived presigned URLs issued after a permission and consent check, with the issuance logged.

**Upload pipeline.** Client requests a presigned upload → uploads directly to object storage → server records `document_reference` → async job runs virus scan, thumbnail generation, and PDF page count. Files never transit the API server.

**Structured results.** Alongside the file, key numeric results are captured as LOINC-coded `observation` rows. v1 is manual entry against a curated panel of the most common Indian lab tests (CBC, LFT, KFT, lipid profile, HbA1c, TSH, fasting/PP glucose). This is the smallest set that makes trend graphs useful. OCR/LLM extraction is deliberately deferred to a later sub-project, with the `observation.source` field present from day one so extracted values can be distinguished from entered ones and reviewed before being trusted.

---

## 10. API and application surfaces

**API.** REST, versioned (`/api/v1`), JSON. Not GraphQL — a solo-maintained clinical API benefits from explicit, auditable, cacheable endpoints, and authorisation is far easier to reason about per-endpoint than per-field.

A separate `/fhir/R4` read surface exposes core resources (`Patient`, `Encounter`, `Condition`, `MedicationRequest`, `Observation`, `DocumentReference`, `CodeSystem`, `ConceptMap`) as conformant FHIR R4 JSON. This is the seam through which ABDM integration, hospital HIS integration, and data export all eventually arrive. Built as a translation layer over the relational model, not as a second store.

**Clinical web app** (React + Vite + TanStack Query) — clinicians, front-desk, admins. Desktop-first; hospital workstations are desktops.

**Patient portal** — same codebase, separate route tree and auth surface, mobile-first. Timeline, reports, consent management, access history.

The timeline view is the product's centrepiece and deserves disproportionate design effort: a single chronological stream, hospital and system-of-medicine visually distinguished, filterable by category, with the vocabulary rendered according to who is reading.

### Tech stack summary

| Layer            | Choice                                            |
| ---------------- | ------------------------------------------------- |
| Language         | TypeScript (server + both clients)                |
| API framework    | NestJS                                            |
| Database         | PostgreSQL (RLS, `pg_trgm`, FTS, JSONB)           |
| ORM / migrations | Drizzle                                           |
| Frontend         | React + Vite + TanStack Query                     |
| Object storage   | S3 (ap-south-1)                                   |
| Jobs             | BullMQ on Redis                                   |
| Auth             | Custom on Postgres — OTP + TOTP; ABHA login later |
| Testing          | Vitest, Testcontainers, Playwright                |

---

## 11. Security, privacy, compliance

Applicable regimes: **DPDP Act 2023** (Health24 is a Data Fiduciary), **EHR Standards for India 2016**, **ABDM** policy and the Health Data Management Policy, and IT Act §43A / SPDI rules.

Baseline requirements, all treated as functional requirements rather than hardening tasks:

- TLS everywhere; HSTS; encryption at rest for database and object storage.
- Field-level encryption for the highest-sensitivity identifiers.
- MFA mandatory for every clinical and admin account.
- Read-logging of all PHI access, append-only, retained per policy.
- Data residency: all storage and processing within India.
- Backups encrypted, tested by periodic restore drills — an untested backup is not a backup.
- Secrets in a managed secret store, never in the repository.
- Dependency and container scanning in CI.
- Documented breach-notification runbook before the first real patient record is created.

**Legal workstream, running parallel to the code and not solvable by it:** DPDP registration and consent-manager obligations, terms and privacy policy drafted by counsel, data-processing agreements with each hospital, NAMASTE and ICD-11 redistribution licensing, professional indemnity, and a decision — taken deliberately, with advice — on whether any feature drifts toward CDSCO medical device classification.

---

## 12. Testing strategy

- **Unit** — terminology mapping, consent evaluation, identity matching. These three carry the highest cost of being wrong and are pure functions; they get exhaustive coverage.
- **Integration** — every API endpoint against a real Postgres in Docker. No mocked database for a system whose correctness is largely relational.
- **Authorisation tests as a first-class suite** — for every endpoint, an explicit test that the wrong tenant, wrong role, and revoked consent are each denied. This suite is the one that prevents the catastrophic failure.
- **End-to-end** — Playwright over the core journeys: register patient, record a dual-coded diagnosis, grant consent, view from a second hospital.
- **Migration tests** — every migration applied to a seeded database in CI.
- **TDD** for terminology, consent, and identity matching specifically.

---

## 13. Infrastructure

| Concern        | Choice                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| Hosting        | AWS Mumbai (`ap-south-1`) — data residency is a legal requirement      |
| Compute        | Containers on ECS Fargate, or a managed platform; not hand-managed VMs |
| Database       | RDS PostgreSQL, multi-AZ, PITR enabled                                 |
| Object storage | S3, SSE, versioning on, no public access                               |
| Jobs           | BullMQ on Redis (scans, thumbnails, timeline projection rebuilds)      |
| CI/CD          | GitHub Actions — lint, typecheck, test, migrate, deploy                |
| Errors         | Sentry                                                                 |
| Metrics / logs | CloudWatch initially; structured JSON logs with PHI scrubbed           |

Environments: local (Docker Compose), staging (synthetic data only), production. **Real patient data never leaves production and is never copied to any other environment.** Test data is synthetic, always.

---

## 14. Roadmap

Estimates assume one developer working consistently. They are ranges because solo estimates that are not ranges are fiction.

| Stage | Sub-project                  | Outcome                                                                       | Estimate                 |
| ----- | ---------------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| 1     | SP1 Foundation               | Hospitals, staff, patients, auth, RLS, audit skeleton, CI, deploys            | 6–10 weeks               |
| 2     | SP2 Terminology              | NAMASTE + ICD-11 ingested, search, concept maps, translate API, curation tool | 6–10 weeks               |
| 3     | SP3 Clinical record          | Encounters, dual-coded diagnoses, prescriptions, the timeline                 | 8–12 weeks               |
| —     | **Milestone A**              | **The core promise is demonstrable end to end**                               | **~5–8 months**          |
| 4     | SP4 Documents & results      | Report upload, storage, LOINC observations, trends                            | 5–8 weeks                |
| 5     | SP5 Patient portal & consent | Patient login, consent grant/revoke, access history                           | 6–9 weeks                |
| —     | **Milestone B**              | **Pilot-ready with one hospital, real consent**                               | **~8–12 months**         |
| 6     | SP6 Operations               | Orders, procedures, billing, reporting                                        | 8–12 weeks               |
| 7     | Compliance & pilot           | Security review, pen test, legal, DPA, runbooks                               | 6–10 weeks               |
| 8     | ABDM                         | ABHA linking, HIP/HIU adapters, sandbox certification                         | Scoped after Milestone B |

**Recommendation on sequencing:** find a pilot hospital — ideally an integrated Ayush + allopathic facility — before Stage 3 completes. Building Stages 4–6 without a real clinician using Stage 3 daily is the most likely way to spend a year building the wrong thing.

---

## 15. Open questions

Answers to these change the design. They are not blocking this plan, but they block the sub-project specs.

1. **NAMASTE licensing.** Are the code sets redistributable inside a commercial product? Must be confirmed before SP2 is specified.
2. **NAMASTE→TM2 mappings.** Does an official mapping exist and is it obtainable, or must Health24 curate mappings itself? If the latter, SP2 grows significantly and needs qualified clinical review.
3. **Clinical reviewer.** Who is the qualified Ayurvedic practitioner who validates mappings and the clinical data model? This role cannot be filled by the developer, and the product's credibility depends on it.
4. **Pilot hospital.** Identified, or to be found?
5. **AYUSH systems in v1.** Ayurveda only to start, or Siddha and Unani too?
6. **Language and script support.** English-only UI in v1, or Hindi / regional from the start? Retrofitting i18n is meaningfully more expensive than starting with it.
7. **Prescription vocabulary.** Is there a standard coded catalogue for Ayurvedic formulations to use, or does Health24 build one? This is the same problem as diagnosis coding, one layer down, and it is currently unsolved in this plan.
8. **Budget.** Cloud, licences, security review, and legal are real recurring costs before there is any revenue.

---

## 16. Risks

| Risk                                                                 | Severity     | Response                                                                                           |
| -------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| Mapping quality is poor or unverifiable                              | **Critical** | Advisory codes clearly labelled; qualified clinical review; never present a mapping as a diagnosis |
| Hospitals will not adopt a system that duplicates their existing HIS | **Critical** | Import / integration path via the FHIR surface; target facilities without an incumbent HIS first   |
| PHI breach                                                           | **Critical** | Defence in depth, RLS, read-logging, external pen test before pilot, tested incident runbook       |
| Wrong-patient record merge                                           | **Critical** | No auto-merge below high confidence; human review queue; reversible merges with full log           |
| Solo-developer scope collapse                                        | **High**     | Strict sub-project staging; Milestone A before anything in SP4–SP6                                 |
| DPDP obligations underestimated                                      | **High**     | Engage counsel before pilot, not after                                                             |
| Clinicians reject the data-entry burden                              | **High**     | Time the diagnosis-entry flow with a real clinician at Stage 3; if it exceeds paper, redesign it   |
| Terminology release changes break records                            | **Medium**   | Versioned concepts; records reference version; never mutate in place                               |
| Cloud cost outruns funding                                           | **Medium**   | Modest baseline; cost alarms from day one                                                          |

---

## 17. Next step

Review this document. When you are satisfied with it, the next action is a detailed implementation plan for **SP1 — Foundation** only: schema, migrations, endpoints, tests, and task ordering, at a level that can be executed against.

No code will be written before that plan exists and you have approved it.
