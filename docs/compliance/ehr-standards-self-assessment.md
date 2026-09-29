# EHR Standards for India 2016 — self-assessment

Where this system meets the Ministry of Health and Family Welfare's *Electronic
Health Record Standards for India (2016)*, and where it does not (sp7-plan.md,
T28, DF10).

**Assessed on 2026-09-28 by the developer.** The Standards are a recommendation
made mandatory in practice by ABDM and by hospital procurement, so the gaps here
are the ones that decide whether a hospital can buy this — not only whether it
should.

| Verdict | Meaning |
| --- | --- |
| **Satisfied** | Done, and something proves it |
| **Partly** | The shape is right; what is missing is named |
| **Open** | Not done |

---

## Identifiers

| Standard | Verdict | Where |
| --- | --- | --- |
| A unique health identifier for the patient | **Satisfied** | Every patient has a platform-wide id and a per-hospital MRN, the same person is recognised across hospitals by a matching workflow with a human decision (`sp1-plan.md`), and an ABHA can be confirmed against the national registry (`sp8-plan.md`) |
| ABHA (Ayushman Bharat Health Account) number and address | **Satisfied** | Verified through the gateway with the patient reading a code back, recorded with the method and the moment, and frozen afterwards. A **typed** ABHA is deliberately not treated as identity — the distinction is enforced in the database (`docs/abdm.md`) |
| Facility identifier (HFR) | **Partly** | `hospital.hfr_id` carries it, and every ABDM call is made for that facility. Registering a real facility is the pilot hospital's to do |
| Provider identifiers (HPR) | **Open** | Staff carry internal ids only |

## Terminology

| Standard | Verdict | Where |
| --- | --- | --- |
| **SNOMED CT** as the clinical terminology, under India's national licence | **Open** | This is the largest gap in this page. The record codes diagnoses in NAMASTE and ICD-11 (TM2 and biomedical), which is what an Ayush record needs and what ABDM's morbidity reporting asks for — but the Standards name SNOMED CT for clinical findings, and a hospital's procurement will ask for it |
| **LOINC** for laboratory observations | **Satisfied** | Results are coded in LOINC, with panels, units and reference ranges, and converted to a canonical unit for trends (`sp4-plan.md`) |
| A coded drug vocabulary | **Open** | Prescriptions carry a medicine name, a strength, a form and a route as text. There is no coded Ayurvedic formulation catalogue to adopt, and this is an open question in `planning.md` §15 |
| Dual coding of traditional medicine terms | **Satisfied, and it is the point of the system** | Every diagnosis carries the clinician's NAMASTE term and the ICD-11 code its mapping gives, with the mapping's equivalence and the version it came from, kept as a snapshot so a later change cannot rewrite history (`sp2-plan.md`, `sp3-plan.md`) |

## Data structure and exchange

| Standard | Verdict | Where |
| --- | --- | --- |
| **HL7 FHIR** as the exchange format | **Satisfied, with deviations recorded** | The data model is FHIR-shaped throughout, a patient's exported copy is generated as FHIR, records shared through ABDM are FHIR document bundles, and `/fhir/R4` serves Patient, Encounter, Condition, MedicationRequest, Observation, DocumentReference, CodeSystem and ConceptMap as a read-only translation layer. Conformance to ABDM's published profiles is **not claimed**; the nine deviations are listed in [docs/fhir.md](../fhir.md) |
| Metadata and Data Standards (MDDS) for demographics | **Partly** | Name, gender, date of birth, address and phone follow the expected shapes; the full MDDS code lists for state and district are not used |
| **DICOM** for imaging | **Not applicable, today** | Radiology arrives as a report document, not as images. If image viewing is ever built, this row changes |
| Document formats: PDF/A for clinical documents | **Partly** | Discharge summaries and invoices are rendered as PDF; they are not PDF/A, which is the archival profile the Standards prefer |

## Privacy and security

| Standard | Verdict | Where |
| --- | --- | --- |
| Access control by role, and by relationship to the patient | **Satisfied** | A permission matrix per role, enforced by guards and proved by a sweep over every route; and consent, enforced in the database rather than the application |
| Consent for access, recorded | **Satisfied** | Consent artefacts with categories, dates and capture method (`sp3-plan.md`, `sp5-plan.md`) |
| Emergency access, with accountability | **Satisfied** | A reason is required, the patient is told, the hospital's administrator reviews it |
| **Audit trail of every access**, tamper-evident | **Satisfied** | Every read and write, append-only, enforced by a trigger and asserted by tests; failures are counted and alerted on |
| Encryption in transit and at rest | **Satisfied** | TLS everywhere, `rds.force_ssl`, KMS on the database, the bucket and the logs; second factors and card tokens encrypted with a rotatable key |
| Authentication, with a second factor for clinical users | **Satisfied** | Mandatory TOTP for every staff account; OTP for patients |
| Data retention and disposal | **Partly** | The mechanics exist; the periods are unconfirmed — `retention-and-erasure.md` |
| ISO 27799 / information security management | **Open** | No ISMS, no certification, no external audit. Realistic for a system before its first pilot; not realistic for a hospital's procurement questionnaire |

## Clinical content

| Standard | Verdict | Where |
| --- | --- | --- |
| Problem list, medications, allergies, procedures, results, notes | **Satisfied** | All present, versioned, attributed to a named clinician, and never overwritten |
| Discharge summary | **Satisfied** | Composed from the encounter's own data, edited and signed by a clinician, rendered as a document the patient receives (`sp6-plan.md`, DF6) |
| Orders and results linked | **Satisfied** | A result closes the order it belongs to; an order with no result is visible as outstanding |
| Immunisation record | **Open** | Not modelled |
| Care plans | **Open** | Not modelled |

---

## The gaps, in the order they will be asked about

| # | Gap | What it takes | Before |
| --- | --- | --- | --- |
| 1 | **SNOMED CT** | India's national licence, a mapping strategy from NAMASTE, and a clinical reviewer. It is a sub-project, not a task | Hospital procurement, ABDM certification |
| 2 | **ABDM certification** | Sandbox credentials, a registered facility, and an assessment. The adapters are built and tested against a mock; nothing has met ABDM ([abdm-certification.md](abdm-certification.md)) | A pilot that claims ABDM compatibility |
| 3 | **`Composition.author` in shared bundles** | A decision with a clinical reviewer about what a visit record's author is. FHIR requires the element and a strict receiver will reject the bundle without it | ABDM certification |
| 4 | **A coded prescription vocabulary** | An answer to `planning.md` §15 Q7 — adopt one or build one, with clinical review | Before claiming interoperable prescriptions |
| 5 | **PDF/A** for archival documents | A rendering change | Before a hospital's records officer asks |
| 6 | **MDDS code lists** for address fields | Data, not design | Before ABDM |
| 7 | **ISO 27799 posture** | An ISMS, and eventually an audit | Before scale |

**The honest summary, as it stands after SP8:** the security, audit, consent and
clinical-content halves of the Standards are in good shape and tested. Of the
interoperability half, **ABHA and FHIR over the wire are now built** — verified
identity, care-context linking, consent from the national consent manager,
encrypted transfer, and a read surface — and **SNOMED CT is not**, which leaves
it as the largest single gap on this page. What is built has been tested
against a mock of the gateway and assessed by nobody; see
[abdm-certification.md](abdm-certification.md) before repeating any of it to a
hospital.
