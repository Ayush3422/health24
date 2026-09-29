# The `/fhir/R4` surface

A read-only FHIR R4 representation of the same record `/api/v1` serves
(`planning.md` §10, `sp8-plan.md` Phase 6). It is the seam other systems
arrive through — ABDM, a hospital's own HIS, an integration nobody has written
yet — and it is deliberately narrow.

**It grants nothing.** Every read runs under the caller's own credentials, the
same permissions and the same row-level security as the ordinary API. A FHIR
client is a member of staff with a token, seeing what that member of staff
sees, in a different shape. This surface adds a representation, not an access
path — and `authorization.e2e-spec.ts` sweeps these routes exactly as it
sweeps the rest, so a new resource here cannot ship without somebody deciding
who may read it.

---

## Where it is, and what it serves

Base: **`/fhir/R4`**, outside the `/api/v1` prefix. A FHIR client is given a
base URL and expects `{base}/Patient/{id}` to work; versioning it twice would
mean two version numbers that can disagree.

`GET /fhir/R4/metadata` is public and returns the `CapabilityStatement`. It
names capabilities, not patients, and a client has to be able to read it
before deciding whether to authenticate.

| Resource | Read | Search | Permission |
| --- | --- | --- | --- |
| `Patient` | yes | `_id`, `identifier` | `patient:read` / `patient:search` |
| `Encounter` | yes | `patient` (required) | `clinical:read` |
| `Condition` | yes | `patient` (required) | `clinical:read` |
| `MedicationRequest` | yes | `patient` (required) | `clinical:read` |
| `Observation` | yes | `patient` (required) | `clinical:read` |
| `DocumentReference` | yes | `patient` (required) | `clinical:read` |
| `CodeSystem` | yes | `_id`, `url` | `terminology:read` |
| `ConceptMap` | yes | `_id`, `url` | `terminology:read` |
| `ConceptMap/$translate` | — | `system`, `code`, `target` | `terminology:read` |

**Every clinical search must name a patient**, and is refused without one.
There is deliberately no way to ask this surface for all of anything: "give me
every Condition" is what an integration writes once and a breach report
describes later.

---

## Deviations, in full

This is the list `sp8-plan.md` T30 asks for. Nothing here is a bug to be
fixed quietly later; each is a decision, and the ones that are gaps say so.

### 1. Conformance to ABDM's published profiles is not claimed

The resources follow FHIR R4 and this system's own mappings. ABDM publishes a
profile per health information type with required sections and coded slices,
and **this surface has not been validated against them.** The bundles pushed
to a requester (`docs/abdm.md`) are document bundles led by a typed
`Composition`, which is close to those profiles and is not asserted to be
conformant. Reconciling them is a task in Phase 8, against the sandbox.

### 2. Validation is by the specification's cardinalities, not by a validator

`conformance.spec.ts` asserts the elements R4 marks `1..1` on every resource
this system produces, that a document bundle leads with its `Composition`,
and that every reference inside a bundle resolves to something the bundle
carries. It is not a StructureDefinition validator: a real one needs the
published definitions and a dependency this project has not taken on for a
read surface. Where the test cannot reach, this page is the record.

### 3. `Composition.author` is not written

R4 marks it `1..*`. This system does not write it, because the honest value —
which clinician authored the visit record — is not a single person for a
record assembled from a visit, and naming the hospital as the author would be
a claim about attribution that the record does not support. A receiving
system that validates strictly will reject the bundle on this element. It is
the most likely single cause of a conformance failure at certification, and it
is first on the list for Phase 8.

### 4. The chief complaint travels; a clinician's note never does

A care context's **display** carries nothing clinical, because it is shown on
a consent screen anybody may glance at. A **bundle** is the opposite
situation: it goes only to a requester the patient authorised for the
`encounters` category, and the reason for a visit is what an encounter is —
so `Encounter.reasonCode` carries the chief complaint.

Clinicians' free-text notes are a different thing and are never exposed, here
or through ABDM, by any health information type. SP5 decided that for the
patient's own export — whether a doctor's note belongs in a bundle is a
clinical reviewer's call, not a mapping one — and nothing since has changed
it.

### 5. `CodeSystem` and `ConceptMap` are metadata only

`content` is `not-present` and the concepts are not expanded. A release holds
tens of thousands of codes, and putting them in one resource would make an
unusable response out of a question somebody only asked to see what versions
exist. `count` says how many there are and `$translate` is how a code is
looked up.

`ConceptMap` carries an extension, `urn:health24:approved-element-count`,
because the number that matters is how many mappings are **approved** — a
proposed mapping is not a mapping yet (SP2), and FHIR has no standard place
to say so.

### 6. `$translate` answers with provenance FHIR does not require

Beside the code and the equivalence, each match names the concept map element
it came from and — when the release is a demo one — says `experimental` out
loud. An advisory code presented without its provenance is a code somebody
will have to guess the standing of, and this system has refused to let anyone
guess since SP2.

### 7. Reading one resource reads the whole record

Answering `Condition/{id}` builds every resource of that patient's record and
picks one out. It is more work than the answer needs, and it is deliberate for
now: it keeps one code path and one set of mappings, so a `Condition` here is
byte-for-byte the `Condition` in a patient's export and in an ABDM bundle. If
this surface is ever used at volume, `FhirService.resourcesFor` is the single
place to change.

### 8. No `_history`, `_include`, `_revinclude`, chaining, or `_format`

None of them is served, and the `CapabilityStatement` says so. Responses are
`application/json`; a client asking for XML gets JSON.

### 9. It is read-only, permanently

There is no create, update, delete or transaction, and there is not intended
to be. The clinical record is written through `/api/v1`, where the
append-only rules, the guard triggers and the audit trail live. Two write
paths into an append-only record is how those guarantees quietly stop holding
(`sp8-plan.md`, DF10).
