# SP2 — Terminology Service: Implementation Plan

**Status:** Backend complete (Phases 1–6). Interface (Phase 7) in progress.
**Scope:** NAMASTE and ICD-11 code systems, versioned ingestion, script-aware search, concept maps, the translate and auto-coding services, and the mapping curation workflow.
**Design reference:** `planning.md` §7 · `features.md` SP2

---

## What research changed

Checked before planning, rather than assumed:

| Question | Finding | Consequence |
|---|---|---|
| Does an official NAMASTE → ICD-11 TM2 mapping exist? | Yes. Under the WHO–Ministry of Ayush donor agreement (2020–2025), 1,941 national Ayush morbidity codes were mapped, and TM2 was released on the WHO ICD-11 Browser in February 2025. *Source: search summary of the IJAR 2025 roadmap paper; the full text is paywalled and was not read.* | SP2 does not curate mappings from nothing. It imports an authoritative map and supports review of local corrections. Roughly halves the curation scope anticipated in `planning.md` §15. |
| Can ICD-11 be used in a commercial product? | Yes. CC BY-ND 3.0 IGO: commercial use permitted provided codes are not adapted, WHO is cited, and no WHO endorsement is implied. | Codes and titles are stored verbatim and never edited. Attribution is stored per release and displayed. |
| NAMASTE licence and download format? | **Not stated** on the NAMASTE portal. | **Unresolved.** No real NAMASTE data is committed or loaded until confirmed. |
| Is the NAMASTE → TM2 mapping downloadable, and in what format? | **Not established.** | **Unresolved.** The importer takes a documented canonical format; a converter is written once the real file is in hand. |

## Assumptions stated

1. The engine is built and tested against **synthetic data**. Every demo code carries a `DEMO-` prefix and every demo release is flagged experimental, so neither can be mistaken for a real NAMASTE or ICD-11 code.
2. Traditional terms in the demo data (Amlapitta, Jvara, Prameha…) are real words used for search realism. **No demo mapping asserts a clinical correspondence.** Demo targets are neutral placeholders.
3. Loading real releases is blocked on licensing and format, and is out of scope here.

---

## Definition of done

1. A terminology release is imported from a file, validated, and stored as an immutable, versioned code system.
2. Re-importing an identical release is a no-op; re-importing the same version with different content is refused.
3. Searching `अम्लपित्त`, `amlapitta`, `Amlapitta` and `amlapitta` (IAST) finds the same concept.
4. Translating a NAMASTE code returns only **approved** map elements.
5. Auto-coding attaches the TM2 translation, and a biomedical code only as advisory and only for `equivalent` or `wider` equivalence. Unmapped is a normal result, not an error.
6. A curator cannot approve a mapping they proposed themselves.
7. Every governance action — import, activation, approval, rejection, proposal — is audited.
8. The authorisation suite covers every new route.

---

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tenancy | Terminology is **not** tenant-scoped | Reference data, not patient data. Every hospital reads the same vocabulary. |
| Versioning | One `code_system` row per `(key, version)`; one active version per key | A diagnosis coded in 2026 must still resolve after a 2029 release retires the code. |
| Immutability | Concepts and designations are never updated or deleted; releases are hashed | A published code set that silently changes under existing records is a data-integrity failure. Also required by CC BY-ND. |
| Import path | CLI, not an HTTP endpoint | Releases are large, rare, and platform-operated. A web-exposed bulk write is attack surface with no user. |
| Search normalisation | One `foldTerm` in `@health24/shared`, used at index time and query time | If indexing and querying fold differently, search fails silently. Sharing the function makes that impossible. |
| Auto-coding safety | Only `approved` map elements are ever attached to a diagnosis | An unreviewed mapping attached to a patient record is a clinical assertion nobody made. |
| Separation of duties | The proposer of a mapping cannot approve it | Four-eyes review is the ordinary clinical-governance control, and it is cheap here. |
| Curator role | New `terminology_curator`, platform-level, no hospital | Mapping review is clinical judgement exercised for the whole platform, not one hospital. Curators cannot read patient data. |
| Platform admin | Can activate releases, **cannot** approve mappings | Operating the platform is not a clinical qualification. |
| Audit | Governance writes audited; searches not | Terminology reads are not PHI. Logging every keystroke of autocomplete would bury the entries that matter. |

---

## Task breakdown

### Phase 1 — Model
- [x] **T1** `terminology_curator` role and terminology permissions
- [x] **T2** Shared schemas: canonical release formats, search, translate, auto-code, curation
- [x] **T3** `foldTerm`: Devanagari and IAST transliteration-tolerant folding, with tests
- [x] **T4** Tables: `code_system`, `concept`, `concept_designation`, `concept_map`, `concept_map_element`, `concept_map_review`
- [x] **T5** Migration: trigram index, one active version per key, immutability by grant and trigger

### Phase 2 — Ingestion
- [x] **T6** Code system importer: validate, hash, idempotent, refuse a changed republish
- [x] **T7** Concept map importer honouring the release's review policy
- [x] **T8** `pnpm terminology:import <file>` CLI
- [x] **T9** Synthetic demo releases
- [x] **T10** Activate and retire versions

### Phase 3 — Read API
- [x] **T11** Search
- [x] **T12** Concept lookup with parent and children
- [x] **T13** Code system listing with attribution

### Phase 4 — Translation
- [x] **T14** Translate: approved elements only
- [x] **T15** Auto-code: primary, translated, advisory

### Phase 5 — Curation
- [x] **T16** Review queue
- [x] **T17** Approve and reject, with separation of duties
- [x] **T18** Propose a correction that supersedes an element
- [x] **T19** Mapping coverage report
- [x] **T20** Audit every governance action

### Phase 6 — Verification
- [x] **T21** Unit: folding, release hashing, auto-code rules
- [x] **T22** Integration: import idempotency, approved-only translation, separation of duties, authorisation entries
- [x] **T23** Smoke script

### Phase 7 — Interface
- [ ] **T24** Terminology search and browse
- [ ] **T25** Auto-code preview
- [ ] **T26** Curation console

---

## Out of scope

- Loading real NAMASTE or ICD-11 releases (blocked on licensing and format)
- WHO ICD-API synchronisation (requires registered credentials)
- SNOMED CT and LOINC
- Tamil-script (Siddha) and Urdu-script (Unani) search folding — Devanagari and Latin only in this sub-project
- Re-flagging existing diagnoses when an approved mapping is later retired (SP3, once diagnoses exist)
