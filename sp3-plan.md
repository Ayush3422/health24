# SP3 — Clinical Record: Implementation Plan

**Status:** In progress. Decisions A and B answered 2026-09-13: **A1** and **B1**.
**Scope:** Encounters, dual-coded diagnoses, prescriptions, allergies, vitals, clinical notes, procedures, the cross-hospital timeline, and a read-only offline cache.
**Design reference:** `planning.md` §5, §6.3, §7.4, §8 · `features.md` SP3 · `sp2-plan.md`

---

## 0. Decisions A and B

**Answered 2026-09-13: A1, staff-recorded consent; B1, structured prescriptions with free-text medicine names.** The options considered are kept below for the record.

Two refinements came out of designing the model against A1:

- **Consent is recorded at the grantee hospital.** The hospital asking to see a patient's history is the one that must ask the patient — and the hospital holding the record never sees the patient again, so it cannot be the one to ask. In the acceptance scenario, City General's front desk records the consent when the patient arrives. This matches ABDM, where the requesting facility initiates consent.
- **Merged records resolve through an alias table.** Clinical rows keep the patient id they were recorded against; rewriting them on merge would break both immutability and merge reversal. Consent checks and the timeline resolve ids through `patient_merge_alias`, which holds identifiers only.

### Decision A — Can Hospital B see what Hospital A recorded, before the consent system exists?

This is the product's core promise, and it collides with sequencing. `planning.md` §8 says cross-hospital visibility requires a consent artefact, but the consent system — patient login, grant, revoke — is SP5. Built strictly in order, SP3 would deliver a clinical record that only its own hospital can read, and Milestone A ("the core promise is demonstrable end to end") would not actually be demonstrable.

| Option                                         | What it means                                                                                                                                                                                                                                                                      | Trade-off                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1. Staff-recorded consent** _(recommended)_ | Build the `consent_artefact` table and enforcement now, exactly as §8 designs it. Front desk records the patient's consent at registration — scope, date range, expiry — after asking them in person. SP5 later adds the patient-facing grant and revoke on top of the same table. | Real consent enforcement from day one, on the final data model. Weaker than patient self-service, because a staff member attests that the patient agreed. Needs a printed or signed consent step at the desk until SP5. |
| A2. Own-hospital only until SP5                | SP3 records and shows each hospital's own data only.                                                                                                                                                                                                                               | Safe and simple. The cross-system bridge — the reason the product exists — cannot be shown to anyone until SP5.                                                                                                         |
| A3. Visible to any linked hospital             | Once a patient is linked to Hospital B, B sees everything.                                                                                                                                                                                                                         | Fastest demo. **Not recommended:** it is data sharing without consent under the DPDP Act, and retrofitting consent onto live data later is much harder than building it first.                                          |

**Break-glass** — emergency access without prior consent, with a typed reason, patient notification and review — is designed with whichever option is chosen, and is only meaningful under A1.

### Decision B — How are medicines coded?

Diagnoses have a coding story (SP2). Prescriptions do not. No standard coded catalogue of Ayurvedic formulations was identified in `planning.md` §15 Q7, and India has no single national drug dictionary for allopathic medicines either.

| Option                                                                      | What it means                                                                                                                                                                                                                                                                                                                              | Trade-off                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1. Structured free text now, a curated formulary later** _(recommended)_ | A prescription records name, strength, dose, frequency, route, duration, vehicle (_anupana_) and timing relative to food as separate fields. The medicine name is free text with an optional coding slot. A Health24 formulary is loaded later through the SP2 terminology pipeline — which already handles versioning, search and review. | Nothing is blocked. Structured fields keep the "current medications" view useful. Free-text names cannot be matched reliably across hospitals until the formulary exists. |
| B2. Build a formulary first                                                 | Curate an Ayurvedic formulation list before prescriptions ship.                                                                                                                                                                                                                                                                            | Better data. Needs a qualified reviewer and a source list, and blocks SP3 on clinical-content work that code cannot do.                                                   |
| B3. Adopt an external dictionary                                            | For example the SNOMED CT drug extension via India's national licence.                                                                                                                                                                                                                                                                     | Strong for allopathic medicines; weak or absent for Ayurvedic formulations. Licensing and distribution to confirm.                                                        |

---

## Decisions already made

| #   | Decision                                                                                                           | Source                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| S1  | **Read-only offline cache.** Today's patients stay viewable during an outage; new entries wait for the connection. | Your answer, overnight                          |
| S2  | Diagnoses are dual-coded through SP2's `autoCode`. Only approved mappings are attached.                            | `sp2-plan.md`                                   |
| S3  | Clinical records are never edited or deleted. Corrections are new versions.                                        | `planning.md` §6, and the pattern proven in SP2 |
| S4  | No clinical decision support and no drug-interaction checking.                                                     | `features.md` excluded list                     |

---

## Definition of done

1. A clinician opens an encounter, records a diagnosis by searching NAMASTE, and the diagnosis stores the primary coding, the TM2 translation and any advisory biomedical code **as they were at that moment**.
2. Prescriptions record Ayurvedic and allopathic medicines side by side, separated by system of medicine.
3. A recorded allergy appears as a persistent banner on every clinical screen for that patient.
4. A correction creates a new version; the original remains viewable and is marked superseded or entered in error.
5. The timeline shows one chronological stream across hospitals, distinguished by hospital and system of medicine, and shows another hospital's entries **only** where consent permits (Decision A).
6. With the network disconnected, a clinician can still open today's patients read-only. The cached data is unreadable once the session ends.
7. Every read and write of clinical data is audited, including reads made offline, uploaded on reconnection.
8. The authorisation suite covers every new route; a row-level security suite proves one hospital cannot read another's clinical rows without consent.

---

## Design

### Data model

Tenant-scoped under row-level security, following SP1:

```
encounter             id, patient_id, hospital_id, class, system_of_medicine,
                      attending_staff_id, started_at, ended_at,
                      chief_complaint, status
condition             id, encounter_id, patient_id, hospital_id,
                      clinical_status, onset_date, is_primary, note,
                      recorded_by, recorded_at, version_status,
                      supersedes_id
condition_coding      condition_id, code_system_key, code_system_version,
                      code, display, role(primary|translated|advisory),
                      equivalence, confidence, concept_map_element_id
medication_request    id, encounter_id, patient_id, hospital_id,
                      system_of_medicine, medicine_name, medicine_code?,
                      strength, dose, frequency, route, duration,
                      vehicle?, timing?, instructions, prescriber_id,
                      status(active|stopped|completed), version_status,
                      supersedes_id
allergy_intolerance   id, patient_id, hospital_id, substance, category,
                      reaction, criticality, recorded_by, version_status,
                      supersedes_id
observation           id, patient_id, encounter_id?, hospital_id,
                      code(LOINC), value, unit, effective_at,
                      source(entered), version_status, supersedes_id
clinical_note         id, encounter_id, patient_id, hospital_id,
                      template, body, author_id, version_status,
                      supersedes_id
procedure             id, encounter_id, patient_id, hospital_id, name,
                      code?, performed_at, outcome, notes,
                      version_status, supersedes_id
consent_artefact      (Decision A1) as planning.md §6.4
```

`version_status` is `current | superseded | entered_in_error`. `condition_coding` rows are written once, when the diagnosis is recorded, and never re-derived. If a mapping is later retired, the diagnosis still shows what was attached and when, and a background job flags affected diagnoses for review — the item `sp2-plan.md` deferred to here.

Vital-sign LOINC codes are to be verified against a LOINC release before use and recorded with LOINC's required attribution.

### Cross-hospital reads

A clinician at Hospital B reading the patient's timeline sees:

- everything recorded at Hospital B, and
- entries from other hospitals **only** within an active, unexpired consent artefact granted to Hospital B, limited to its data categories and date range.

Enforced in the database, not only in the service. Each clinical table's row-level security policy admits its own hospital's rows, plus rows covered by a consent artefact for the calling hospital. Every cross-hospital read is audited with the consent artefact it rested on.

### Timeline

A query over the clinical tables behind a single `TimelineService` interface, not the materialised projection `planning.md` §5.1 anticipates. The projection is the right answer at scale. Building it before real query volumes exist means maintaining a second copy of clinical data on a guess. The interface is fixed now so the projection can replace the query later without touching callers. The timeline query gets a performance test with a realistic synthetic volume, and a threshold that triggers the projection work.

### Read-only offline cache (decision S1)

Designed for shared ward workstations, where a cache that outlives the session is a leak waiting to happen.

- **What is cached:** today's encounters at the signed-in hospital, and patients the clinician opened in the last few hours. Summary card, allergies, current medications, active problems, recent vitals. Not full history, not documents.
- **Where:** IndexedDB, encrypted with AES-GCM under a non-extractable WebCrypto key held **in memory only**. Closing the tab, signing out or hitting the idle timeout discards the key; the ciphertext left behind is unreadable. It is also explicitly deleted on sign-out.
- **While offline:** a persistent banner states the data may be out of date and when it was cached. Every write control is disabled, not hidden, so nobody believes an entry was saved.
- **Audit:** an offline view cannot reach the server when it happens. Views are queued locally, encrypted the same way, and uploaded on reconnection with their original timestamps. A session that never reconnects loses those entries — a stated, accepted gap.
- **Consent:** a cached entry is revalidated on reconnection. A consent revoked while offline removes the cached entries when the connection returns.

### Diagnosis entry

The clinician searches in their own vocabulary using the SP2 terminology search, selects a term, and sees exactly what will be recorded — the same view as the terminology screen built in SP2 Phase 7, reused. On save, the service calls `autoCode` and writes the codings in the same transaction as the condition. An experimental (demo) code system cannot be used on a real encounter; the service refuses it outside development.

---

## Task breakdown

### Phase 1 — Model

- [x] **T1** Record Decisions A and B in this plan
- [x] **T2** Clinical tables, versioning columns, RLS policies — migrations `0007`, `0008`; composite foreign keys keep every reference within one hospital's record
- [x] **T3** `consent_artefact` and consent-aware RLS (Decision A1), including merged records via `patient_merge_alias`
- [x] **T4** Immutability: no UPDATE of clinical content, no DELETE — by grant and trigger; corrections checked at commit. Proven in `test/clinical-rls.e2e-spec.ts` (34 tests, as the application role)

### Phase 2 — Encounters

- [x] **T5** Open, close, list encounters — `POST /encounters`, `GET /encounters` (day worklist, or one patient across permitted hospitals), `GET /encounters/:id`, `POST /encounters/:id/finish|cancel`
- [x] **T6** Allergy recording and the patient allergy banner endpoint — `POST /allergies`, `GET /patients/:id/allergies`, highest criticality first, with the recording hospital named via a read-only `hospital_directory`; cross-hospital reads audit the consent they rest on

### Phase 3 — Diagnoses

- [x] **T7** Record a diagnosis with codings snapshotted from `autoCode` — `POST /diagnoses`; codings written in the diagnosis transaction and proven unchanged after their mapping is retired; one primary diagnosis per encounter (migration `0011`)
- [x] **T8** Problem list: active conditions across permitted hospitals — `GET /patients/:id/problems`, plus `GET /encounters/:id/diagnoses`; cross-hospital reads audit their consent
- [x] **T9** Refuse experimental terminology outside development — `ALLOW_DEMO_TERMINOLOGY`, refused by default in production and impossible to enable there; a demo release or demo map returns 422

### Phase 4 — Prescriptions

- [x] **T10** Ayurvedic and allopathic prescriptions (Decision B) — `POST /prescriptions` with structured dose, frequency, route, duration, vehicle and food timing; `POST /prescriptions/:id/stop` with a reason, by the prescribing hospital only; course end dates from one database function (migration `0013`)
- [x] **T11** Current medications across permitted hospitals — `GET /patients/:id/medications` (active, within course, grouped by system of medicine) and `GET /encounters/:id/prescriptions`
- [x] **T12** Allergy check at the point of prescribing — a warning on exact substance match only, not interaction checking. Checks the medicine and its vehicle (anupana) against every allergy the prescriber may see; a match returns 409 `ALLERGY_MATCH` unless overridden with a reason, which is kept on the prescription (migration `0012`)

> **Open question for a clinical and legal reviewer:** the API lets any clinician prescribe under any system of medicine. Whether an AYUSH practitioner may prescribe allopathic medicines (and the reverse) varies by state. Health24 records the system of medicine on every prescription but does not enforce a rule until one is confirmed.

### Phase 5 — Other documentation

- [ ] **T13** Vitals as observations
- [ ] **T14** Clinical notes with department templates
- [ ] **T15** Procedures, including Panchakarma therapies
- [ ] **T16** Corrections: supersede and entered-in-error, with history

### Phase 6 — Timeline and consent

- [ ] **T17** `TimelineService`: one stream, consent-filtered
- [ ] **T18** Patient summary card
- [ ] **T19** Staff-recorded consent: record, expire, revoke (Decision A1)
- [ ] **T20** Break-glass access with reason, notification flag and review queue
- [ ] **T21** Retired-mapping flagging job for existing diagnoses

### Phase 7 — Offline

- [ ] **T22** Service worker and encrypted IndexedDB cache
- [ ] **T23** Offline banner, disabled writes, cache revalidation
- [ ] **T24** Queued offline audit upload

### Phase 8 — Verification

- [ ] **T25** Unit: versioning rules, consent evaluation, cache encryption lifecycle
- [ ] **T26** Integration: every endpoint; RLS with and without consent; audit of cross-hospital reads
- [ ] **T27** Timeline performance test at realistic synthetic volume
- [ ] **T28** Smoke: the Amlapitta scenario from `planning.md` §1, end to end

### Phase 9 — Interface

- [ ] **T29** Encounter screen and diagnosis entry
- [ ] **T30** Prescription entry and current medications
- [ ] **T31** Timeline and summary card, with the allergy banner
- [ ] **T32** Consent recording at the front desk

---

## The acceptance scenario

`planning.md` §1, run as the final smoke test:

1. Sanjeevani Ayurvedic Hospital registers a patient, and a vaidya diagnoses Amlapitta and prescribes two formulations over four months.
2. The patient registers at City General Hospital and is linked to the existing record. City General's front desk records the patient's consent to see their history from other hospitals, and a gastroenterologist opens the timeline.
3. The gastroenterologist sees the diagnosis with its TM2 translation and any approved advisory biomedical code; both formulations with dates and durations; and any recorded allergy as a banner.
4. The patient explains nothing.
5. With consent revoked, step 3 shows nothing from Sanjeevani, and the attempt is audited.

---

## Risks specific to SP3

| Risk                                                          | Response                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Consent recorded by staff is weaker than patient self-service | Printed consent step at the desk; the patient-facing grant and revoke in SP5 build on the same table |
| Clinicians find dual-coded entry slower than paper            | Time the diagnosis flow with a real clinician during Phase 3; redesign if it is slower than writing  |
| Free-text medicine names do not match across hospitals        | Stated limitation until the formulary (Decision B1) exists                                           |
| The offline cache leaks on shared machines                    | Memory-only key, deletion on sign-out and idle timeout, minimal cached scope                         |
| Timeline query slows as history grows                         | Performance test with a threshold that triggers the materialised projection                          |

## Estimate

Consistent with `planning.md` §14: **8–12 weeks** for one developer. The offline cache adds roughly two of those weeks, and Decision A1 roughly one.
