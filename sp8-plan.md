# SP8 — ABDM: Implementation Plan

**Status:** In progress — Phases 1–3 complete, 2026-09-28. Decisions X–AA answered 2026-09-28: **X1, Y1, Z1, AA1**.
**Scope:** Joining the national network as a **Health Information Provider**: an ABHA number and address verified and linked to a patient, care contexts discovered and linked, a consent artefact arriving from the consent manager and landing in the consent model this system already has, and the record assembled as encrypted FHIR bundles and pushed to whoever the patient has allowed — plus the `/fhir/R4` read surface that all of it is built on, the screens that make linking and sharing visible to staff and to the patient, and an honest account of how far this is from a certificate.
**Design reference:** `planning.md` §10 (the `/fhir/R4` surface as the seam ABDM arrives through), §8 (consent and access control), §14 stage 8 · `sp1-plan.md` (patient identity and matching) · `sp3-plan.md` (the clinical record and `app.consent_permits`) · `sp5-plan.md` (the patient's rights, the portal, the FHIR export) · [docs/compliance/ehr-standards-self-assessment.md](docs/compliance/ehr-standards-self-assessment.md) gaps 1–3

**What this sub-project is not.** It is not a consent manager — that is ABDM's, and building a second one would be both wrong and pointless. It is not the HIU half: asking another provider for a record through the gateway is a second certification track and a second set of screens, and Decision X1 leaves it out with its seams named rather than half-built. It is not SNOMED CT (Decision AA1). And it is **not a certification**: everything here can be built, tested and demonstrated against a mock and then a sandbox, and the certificate still requires a registered facility, real credentials and ABDM's own assessment. This plan ends at "ready to be assessed", and says so.

---

## 0. Decisions for you

**Answered 2026-09-28: X1, Y1, Z1, AA1** — the HIP half with ABHA linking; ABDM consent artefacts landing in the existing consent model; a local mock of the gateway first, with the adapter pointed at the sandbox when credentials exist; SNOMED CT deferred with the gap left recorded. The options considered are kept below for the record.

### Decision X — What SP8 builds

| Option | What it means | Trade-off |
| --- | --- | --- |
| **X1. HIP, with ABHA linking** _(chosen)_ | The hospital shares the records it holds: ABHA verification and linking, care-context discovery and linking, consent notification, and encrypted data push on request. | The half ABDM asks for first, and the half whose data this system already holds. It leaves a hospital unable to *pull* another's record through the gateway — which SP5's own consent flow already does between hospitals on this platform, so nothing a user has today is lost. |
| X2. HIP and HIU | Both directions: also requesting consent through the consent manager and reading another provider's record. | The complete exchange. It is a second certification track, a new consent-request surface in the clinical app, and a parser for bundles written by systems we do not control — roughly double, and the second half is worth more once the first is certified. |
| X3. ABHA identity only | Verify and store an ABHA number and address; no exchange at all. | Small, and it improves duplicate matching immediately (`abha_exact` is already a match method). It does not make the system ABDM-compatible in any sense a hospital means when it asks. |

### Decision Y — How an ABDM consent meets the one this system has

| Option | What it means | Trade-off |
| --- | --- | --- |
| **Y1. ABDM consent lands in `consent_artefact`** _(chosen)_ | A consent notified by the consent manager is written as a row in the table SP3 built, with its ABDM identity beside it, and the same database rules decide what it reveals. | One place where "who may read what" is decided, enforced by row-level security rather than by the adapter. The mapping is not free — ABDM's grantee is not a hospital in this database, and its data ranges and HI types have to be translated exactly — and that mapping is where the risk sits. |
| Y2. A separate ABDM path | The gateway's data assembly checks the ABDM artefact itself, outside the consent model. | Less mapping work. It puts the answer to "who may read this" in two places, and the day they disagree is the day a record goes somewhere it should not. That is the most expensive kind of drift this system can have. |
| Y3. Replace our model with ABDM's | ABDM consent artefacts become the only model. | Closest to the standard. It breaks the hospital-to-hospital sharing SP3 and SP5 built, which works today for patients who have no ABHA at all — a large fraction of anyone an Ayush clinic sees. |

### Decision Z — How to start without sandbox credentials

| Option | What it means | Trade-off |
| --- | --- | --- |
| **Z1. A local mock first** _(chosen)_ | One adapter behind an interface, and a mock gateway that speaks discovery, linking, consent notification and data request, so the whole flow runs in tests and on a laptop. The adapter points at the real sandbox when credentials arrive. | The work does not wait for credentials, and every flow gets a deterministic test that CI can run forever. What a mock cannot prove is that ABDM behaves as documented — which is why reconciling the mock against the sandbox is a task, not an assumption. |
| Z2. Straight to the sandbox | Register a client, take the credentials, build against the real thing. | Real behaviour immediately, and the mock's inaccuracies never get written. Every step then depends on credentials and on somebody else's uptime, and no test can run without a secret. |

### Decision AA — SNOMED CT

| Option | What it means | Trade-off |
| --- | --- | --- |
| **AA1. Not now; the gap stays recorded** _(chosen)_ | SP8 ships NAMASTE and ICD-11, as today. The gap in the EHR Standards self-assessment stays, with its owner. | ABDM's own data requirements are met by what is coded today. SNOMED CT needs India's national licence, a mapping strategy and a qualified clinical reviewer — a sub-project, and one the developer cannot start alone. |
| AA2. Take it on inside SP8 | Licence, mapping and clinical review as part of this sub-project. | It closes the largest question a hospital's procurement asks. It also cannot begin until a reviewer exists, and it would hold ABDM hostage to that. |

---

## Defaults taken

Where the plan does not need a decision from you, these are the positions taken. Each is a rule the code is held to.

| # | Default | Why |
| --- | --- | --- |
| DF1 | **ABDM is additive.** No clinical table changes shape, no second store, and every screen that exists today works unchanged for a patient with no ABHA. | `planning.md` D3 said so before any of this was built: modelled FHIR-shaped from the start so the adapters are additive. A patient without an ABHA is the common case in an Ayush clinic, and must stay first-class. |
| DF2 | **One consent model.** An ABDM artefact is a row in `consent_artefact`; `app.consent_permits` and the policies above it stay the only answer to who may read what (Y1). | Two authorities for the same question is the worst failure mode this system has. |
| DF3 | **Nothing leaves without an artefact, and the database enforces that too.** Assembly for a data request runs in a dedicated context bound to one consent id — not in a hospital's context, and never as the owner — so a mistake in the adapter cannot widen what a bundle contains. | The portal's `app.current_patient_id` is the precedent: a context is how this system says "you are allowed exactly this". The alternative is trusting a `WHERE` clause in the code that builds the bundle. |
| DF4 | **One adapter, one wire format, one place that knows it.** Everything outside the gateway folder deals in this system's own types; the protocol version, headers, correlation ids and callback shapes live in one place with a mock beside them (Z1). | ABDM's APIs have already moved once and will again. A version change should be a folder, not a search across the codebase. |
| DF5 | **Every gateway call and every callback is correlated and audited.** A data push is an audited read of every row it contains, attributed to the requester, carrying the consent artefact id — indistinguishable in weight from a hospital reading the same rows. | `planning.md` §6.4. The patient's access history is the promise; an export to a third party that did not appear in it would make that promise false. |
| DF6 | **The patient sees ABDM access in the same place as everything else.** No separate screen, no separate vocabulary: one access history, with the requester named. | A patient does not care which protocol carried their record. |
| DF7 | **Crypto with the platform's own primitives, keys per transfer.** The key pair for a data request is generated for that transfer, used once, and never written to a log or to a column that outlives the transfer. | Node has X25519 and authenticated encryption built in. A dependency here is a dependency in the most sensitive path in the system. |
| DF8 | **Everything asynchronous goes through the queues.** Callbacks, pushes and retries are jobs with a sweep behind them, never work done inside a request (S5). | The gateway is a remote system with its own outages; a request thread waiting on it is an outage here. |
| DF9 | **Sandbox credentials never enter the repository, and the mock is the default.** Development and CI run against the mock with no secret at all; the sandbox is opt-in configuration. | SP7's DF3, unchanged. A test suite that needs a secret is a test suite that stops running. |
| DF10 | **The `/fhir/R4` surface is a read-only translation layer.** It reuses the mappings `record-fhir.ts` already holds, it is versioned, and it never becomes a second way to write clinical data. | `planning.md` §10. Two write paths into an append-only clinical record is how the guarantees quietly stop holding. |
| DF11 | **Nothing claims certification that has not been certified.** The documentation separates what is implemented, what has run against the sandbox, and what ABDM has actually assessed. | SP7's DF10, applied to the claim a hospital is most likely to repeat to a regulator. |
| DF12 | **The HIU seams are named, not built.** Where a future HIU half would attach — consent request, bundle ingestion, the provenance of a foreign row — is written down, and nothing is structured in a way that forecloses it. | X1 defers the work; it should not deform the design. |

---

## Decisions already made

Carried in from earlier sub-projects and not reopened here.

| # | Decision | Source |
| --- | --- | --- |
| S1 | Clinical rows are never edited or deleted; a correction is a new version. | `sp3-plan.md` S3 |
| S2 | Every read and write is audited; the audit trail is append-only. | `planning.md` §6.4 |
| S3 | Row-level security binds to an unprivileged role; tenancy and consent are enforced by the database. | `sp1-plan.md`, `sp3-plan.md` |
| S4 | Dates a person reads are India Standard Time; instants are stored with a time zone. | `sp3-plan.md` |
| S5 | Background work runs on queues with a sweep behind it, never in the request. | `sp4-plan.md`, `sp5-plan.md` |
| S6 | Consent is by data category, by date range, and time-boxed, with expiry a timestamp rather than a status. | `planning.md` §8, `sp3-plan.md` |
| S7 | Data residency is India: storage and processing in `ap-south-1`. | `planning.md` §11, §13 |
| S8 | Configuration is validated at boot; secrets come from a managed store and never from the repository. | `sp7-plan.md` DF2, DF3 |

---

## Definition of done

1. A patient's ABHA number and address can be verified through the gateway and linked to their record, with the verification audited, the identifier never reaching a log line, and duplicate matching using a verified ABHA differently from a typed one.
2. One adapter speaks the gateway protocol — sessions, correlation ids, headers, asynchronous callbacks, retries — and a local mock implements enough of it for every flow below to run with no credentials.
3. Care contexts are modelled, discovered and linked: a discovery request finds the patient by the identifiers ABDM sends and returns only care contexts belonging to them, and a linking flow confirms with a one-time code before any link exists.
4. A consent notified by the consent manager is written as a `consent_artefact` row with its ABDM identity, its data types mapped to this system's categories, and its date range and expiry preserved exactly — and a test proves a notified consent grants no more than it says.
5. A data request assembles FHIR bundles per care context under a database context bound to that consent id, encrypts them as the specification requires, pushes them, and notifies the outcome — with every row they contained recorded in the audit trail against the requester.
6. A revoked or expired consent stops a transfer, including one in flight, and a test proves it.
7. `/fhir/R4` serves `Patient`, `Encounter`, `Condition`, `MedicationRequest`, `Observation`, `DocumentReference`, `CodeSystem` and `ConceptMap` as read-only conformant resources with a `CapabilityStatement`, under the same authentication, authorisation and row-level security as the rest of the API.
8. The clinical app shows a patient's ABHA and their care contexts, and can start a linking flow; the portal shows ABDM access in the same access history as everything else, naming the requester.
9. `docs/abdm.md` describes the flows, the mapping, the configuration and the mock; a runbook covers a failed transfer and a disputed consent; and the certification position states plainly what has and has not been assessed.
10. The acceptance scenario below passes against the mock, and the sandbox reconciliation records what differed.

---

## Phases and tasks

### Phase 1 — ABHA identity

- [x] **T1** The ABHA model as it actually is: a number, an address, when each was verified and by what method, and whether the patient self-declared it or the gateway confirmed it — the column that exists today holds a string with no provenance
- [x] **T2** Verification through the adapter, audited, and matching that treats a verified ABHA differently from a typed one
- [x] **T3** ABHA in the scrubber, the exports and the emergency card: it is an identifier, and SP7's DF4 applies to it
- [x] **T4** What happens on a merge, where two records carry different ABHA numbers — and what happens when they carry the same one

**The column was there since SP1; the claim it made was wrong.** `patient.abha_number`
held fourteen digits and nothing about where they came from, and
`scoreIdentities` said of them that "two records carrying the same one are the
same person by definition". That is true of an ABHA the registry confirmed.
It is not true of one a receptionist typed — and the failure is not exotic: a
newborn is registered as "B/O Meera Joshi", which normalises to exactly the
mother's name, on the mother's phone, with the mother's ABHA copied off her
card. Every identifier agreed, so the two records linked, and the child's
history became the mother's. That case is now a unit test.

**A verification is a challenge and a response, in two steps, and only the
second writes anything.** A single "mark this ABHA verified" call would record
a member of staff's assertion, which is the thing the new columns exist to
distinguish from a confirmation. The patient reads a code back, and only then
does anything change.

**Three refusals, in three different places, for the same rule.** The service
refuses to edit a confirmed identifier and says which route can change it; the
database refuses it again through `app.guard_abha_identity`, so a future
service that forgets cannot; and the matcher refuses to conclude from a typed
one however much else agrees. Each is tested where it lives — the middle one as
the unprivileged application role, with the API out of the way.

**And one of those three is weaker than it looks, which is written into the
migration rather than left to be discovered.** A verification timestamp is
stamped by `app.record_abha_verification` alone, and the guard refuses any
other write to those columns — but that is a guard against a mistake, not a
privilege boundary. The strong form is column-level `UPDATE` on `patient`,
which in Postgres means revoking the table grant and enumerating every other
column, silently freezing any column added later. That trade is worse, and
saying so is better than implying a boundary that is not there.

**What this cost, stated plainly: ABHA no longer links a registration by
itself.** Certainty now requires the ABHA to be verified on *both* sides, and
nothing can yet present a verified one at the moment of registration — that
route is ABHA-first registration, which belongs with discovery in Phase 3.
Until then a typed ABHA is scored as strong evidence (enough to reach the
review queue on its own, never enough to link), and the pairing goes to a
human. A duplicate record costs reconciliation; a false link costs somebody
their history.

**Two holes found on the way, neither of them in the new code.** An ABHA
address has no dot after the `@`, so `lakshmi.devi@abdm` walked straight past
the log scrubber's email pattern — a national identifier in a form that looks
like nothing else, reaching logs untouched since SP5. And registering a patient
with an ABHA another record already held was a 500: the matcher surfaces most
of those as duplicate candidates first, but not one where the name, age and
gender all disagree, and then the unique index was the first thing to object.
It is now a conflict with a code and a sentence.

**The merge had three answers to give, and the third changed the order of two
statements.** Provenance travels with the identifier, so an ABHA adopted by a
surviving record stays as verified as it was. Two *different* verified ABHA
numbers refuse the merge outright — that is the national registry saying these
are two people, and it is resolved at ABDM rather than here. And reverting a
merge had to give the survivor's identifiers back *before* returning the merged
record's, because the unique index will not hold one number on two rows for
even one statement.

**`demographic` was taken out of the verification methods before anything was
built on it.** ABDM offers demographic matching; it is not a challenge, it
confirms nothing about who is standing at the desk, and an enum value for
something unimplemented is exactly the sort of claim DF11 exists to refuse.

### Phase 2 — The gateway adapter and its mock

- [x] **T5** The adapter interface: every ABDM operation this system performs or answers, expressed in this system's own types (DF4)
- [x] **T6** The wire implementation — session tokens, the correlation id on every call, the headers, clock skew, and the asynchronous pattern where the answer arrives as a separate request rather than a response
- [x] **T7** The mock gateway: deterministic, needing no credential, started by the test suite (Z1, DF9) — with the operations that have callers, and a named place for the ones Phases 3–5 add
- [x] **T8** Callback authentication: how a request claiming to be the gateway is proved to be one, and what happens when it cannot be
- [x] **T9** Configuration and its refusals — which variables the ABDM half needs, and the production refusal when it is half-configured (S8)

**ABDM's answer does not come back in the response, and that is the whole
shape of this phase.** A call is accepted with 202 and an empty body; the
answer arrives later as a **separate inbound request** quoting the id that was
sent. So the adapter is not a wrapper around `fetch` — it is a registry of
calls in flight, and `call()` registers the wait *before* it sends, because a
gateway fast enough to call back while we are still reading its 202 is not a
race worth losing.

**One consequence, written into `docs/abdm.md` rather than discovered later.**
A pending call lives in memory in the process that made it, so the callback has
to reach **that** process — several API tasks behind a load balancer need the
callback routed, or one task serving that path. Persisting pending calls was
considered and rejected: after a restart the caller is gone, and resuming the
wait would only create the illusion that a dropped call could be recovered.

**The mock is a server, not a stub**, because only a server can exercise what
this phase is about. It hands out session tokens, refuses a call that does not
carry one, answers 202, and then calls back on its own connection — so the
session cache, the correlation, the headers and the callback endpoint are
tested by being used, over real HTTP, in both directions. It is deliberately
awkward in the ways the real one is: it can be told to answer with an error,
or **not to answer at all**, which is how the timeout path is covered. That is
the failure that never happens on a developer's machine and always happens
eventually.

**T8 got the honest answer rather than the comfortable one.** The right
question was not "how do we authenticate the callback" but "what does the
specification give us to authenticate it with", and the answer is less than one
would like. So there are three checks, and the documentation says what each is
worth: a shared secret, required in production and the one ABDM is least
generous about; **a correlation id we issued and are still waiting on**, which
is the strongest and needs nothing from ABDM at all — an answer to a question
nobody asked is refused, so reaching the URL buys a caller nothing; and a
timestamp within the skew window, in either direction. What none of them
establishes is the **content** of a consent artefact, which rests on the
artefact's own signature and is Phase 4's problem — named here so that nobody
reads the three as covering it.

**The refusal says nothing about which check failed.** Telling a caller their
correlation id was unknown tells them how to find one that is not.

**The session is cached, renewed a minute early, and fetched by one caller at
a time.** Each of the three is a bug when it is missing: a token per call is
two round trips for every operation, a token that lapses mid-flight fails a
request that had nothing wrong with it, and a burst on a cold process asks for
twenty tokens at once — which from the other side looks like an attack. There
is exactly one retry, for exactly one cause: a 401, which means the token, not
the request. Retrying anything else would send a duplicate of something the
gateway may already be acting on.

**Half-configured is the worst of the three modes**, because it looks enabled
and fails on the first call. `ABDM_MODE=gateway` without its five settings is
refused at boot with all of the missing names in one message, rather than one
name per restart.

**The operation list was written before most of it has an implementation**,
with each entry carrying whether it is built. That is the point: it says what
this system's ABDM surface is, it is where Phases 3–5 add rather than inventing
a second way in, and the `built: false` markers mean nothing in it can be read
as a claim (DF11).

### Phase 3 — Care contexts, discovery and linking

- [x] **T10** What a care context is here, decided and written down: the unit a patient recognises and can unlink, mapped onto encounters
- [x] **T11** Discovery: finding the patient from the identifiers ABDM sends, refusing to guess, and never confirming a person exists to a request that did not already know
- [x] **T12** Linking, both directions — the hospital offering a link and the patient initiating one — with confirmation before anything is linked
- [x] **T13** Unlinking, and what it means for consents already granted over those care contexts
- [x] **T14** Row-level security over the new tables, and their place in the coverage sweep

**A care context is one visit, and its description says nothing about what is
wrong with the patient.** The unit was the easy half: a patient recognises
"the visit on the twelfth of April" and can decide about it on its own, where
a per-year grouping would be easier to produce and impossible to consent to.
The display string was the half worth thinking about — it is shown in the
consent manager's app, travels with every consent request, and sits in lists
somebody may glance at. "Diabetes follow-up" would be more useful and would
tell anyone looking over a shoulder what the patient has. Date, kind of visit
and hospital; and the test that keeps it that way is written as a property
rather than a list of forbidden words, because the way it would break is
somebody adding the chief complaint to be helpful.

**Discovery is the only place an outsider asks after a patient by name**, so
it is written as though it were an oracle. There is exactly one way to match —
a **verified** ABHA address equal to the one in the request — and every other
route is a refusal: a typed ABHA is not certainty here either, and a name, a
phone number or a date of birth are what a stranger has. Demographics that
positively disagree refuse a match the ABHA would have made.

**And every refusal is the same refusal.** "No such person", "that person but
you got their year of birth wrong" and "we do not know that facility" each
tell the asker something, so outwardly they are one sentence — asserted in a
test that compares the three answers byte for byte.

**Phase 3 found the hole in Phase 2's authentication, which is the honest
result of building the next thing.** T8's strongest check — that a callback
quotes a call we made and are still waiting on — **cannot apply to a request
the gateway starts.** There is no call of ours for it to be answering. So the
inbound endpoint has the shared secret and the clock and nothing else, and
that gap is not closed by authentication at all: it is closed by discovery
refusing to say anything to a caller who cannot already name a verified ABHA
address. That is written into `callback-auth.ts` and `docs/abdm.md` beside the
three checks, rather than left for somebody to assume the checks cover it.

**Nothing is linked until the patient answers a code, and who sends it
differs.** When the desk offers, the gateway sends it. When the patient asks
from their own health app, **this system** sends it to the number on the
record — because nobody is present and nothing else proves the person holding
the app is the person in the record. The code lives in its own table rather
than SP5's: sharing that one would have meant a code issued to approve a link
could be spent to sign in to the portal.

**The guard refuses the attack the flow invites.** A request's `encounter_ids`
are frozen the moment the patient is asked, so a request made for one visit
cannot be widened to twenty before the confirmation arrives — the code they
read out approves exactly what they were told about.

**ABDM registers a facility; this platform hosts many.** Phase 2 read the
facility id from the environment, which is right for one clinic and wrong
here. The hospital's own `hfr_id` — a column SP1 already had — now carries it
on outbound calls, inbound requests are answered for the facility the header
names, and `ABDM_HIP_ID` stays as the default for a single-facility
deployment.

**The second caller found the first caller's translation.** Turning a gateway
refusal into an answer a person can act on lived inside the ABHA adapter, so
linking's first wrong code came back as a 500. It now lives in one place that
a third caller gets by using it rather than by remembering to.

**And one ordinary bug worth recording** because the failure was at the
database rather than in review: a JavaScript array interpolated into a query
and cast — `${ids}::uuid[]` — binds something the driver will not make an
array of. Every query that takes a list of visits now goes through one helper
that writes the literal form.

### Phase 4 — Consent, mapped onto the model that exists

- [ ] **T15** The mapping, exactly: ABDM's data types to `clinical_data_category`, the permission range to the date range, expiry to expiry, and what happens to anything that does not map (DF2, Y1)
- [ ] **T16** The requester: ABDM's grantee is not a hospital in this database, and `app.consent_permits` requires one and a patient link beside it — decide and migrate without weakening what that function guarantees today
- [ ] **T17** Consent notification handled as a job: written once, idempotent under redelivery, and refusing an artefact for a patient who is not linked
- [ ] **T18** Revocation and expiry arriving from the consent manager, and a revocation made in the portal reaching the other way
- [ ] **T19** A test that a notified consent grants exactly what it says: not a category more, not a day either side

### Phase 5 — Data request and transfer

- [ ] **T20** The dedicated database context for assembly, bound to one consent id, with policies that make over-sharing a database refusal rather than a code review (DF3)
- [ ] **T21** Bundles per care context, reusing the mappings in `record-fhir.ts`, with what a bundle omits stated rather than silently dropped
- [ ] **T22** The crypto: a key pair per transfer, the key agreement and derivation the specification names, authenticated encryption, and nothing sensitive surviving the transfer (DF7)
- [ ] **T23** Transfer as a queued job with retries, partial failure and the outcome notification (DF8)
- [ ] **T24** The audit entries — every row transferred, attributed to the requester, carrying the consent artefact id (DF5)
- [ ] **T25** A consent revoked mid-transfer stops it; a test proves the remaining bundles are never sent

### Phase 6 — The `/fhir/R4` read surface

- [ ] **T26** The surface's shape: base path, versioning, the resources in the definition of done, and a `CapabilityStatement` that does not overstate (DF10)
- [ ] **T27** Read and search for each resource, as a translation layer over the relational model, reusing the existing mappings
- [ ] **T28** `CodeSystem` and `ConceptMap` from the terminology service — the part of this surface that is genuinely ours
- [ ] **T29** Authentication, authorisation and row-level security identical to `/api/v1`, proved by extending the route sweep rather than by inspection
- [ ] **T30** Conformance checked against the published profiles, with every deviation recorded

### Phase 7 — What staff and patients see

- [ ] **T31** The patient's ABHA and care contexts in the clinical app: linked, not linked, and the linking flow
- [ ] **T32** ABDM access in the portal's access history, naming the requester and the consent it rested on (DF6)
- [ ] **T33** The patient's view of consents granted through ABDM, beside the ones they granted here, with revocation reaching the right place
- [ ] **T34** Browser tests for both, including the case that matters most: a patient reading who received their record and when

### Phase 8 — Verification, documentation and the certification position

- [ ] **T35** The acceptance scenario below, walked and written up
- [ ] **T36** `docs/abdm.md`, and a runbook for a failed transfer and for a disputed consent
- [ ] **T37** The certification position: the milestones, what each requires, what is implemented, what has run against a sandbox, and what only ABDM can assess (DF11)
- [ ] **T38** Reconcile the mock against the sandbox when credentials exist, and record every difference (Z1)
- [ ] **T39** The first real `terraform plan`, carried from SP7's acceptance step 8, when there is an account to run it against — and recorded as still open if there is not
- [ ] **T40** Update the EHR Standards self-assessment, the README and `planning.md` §14 with what SP8 closed and what it did not

---

## The acceptance scenario

Lakshmi has an ABHA. She is treated at the Ayurvedic clinic on this platform, and later walks into an allopathic hospital that is not.

1. At the clinic, front-desk enters her ABHA address; it is verified through the gateway and linked to her record, and the verification appears in her access history.
2. Her visit creates a care context, which is linked to her ABHA after she confirms. Nothing is linked before she confirms.
3. The other hospital, as an HIU, asks the consent manager for her records. She approves — diagnoses and prescriptions, six months, thirty days of validity — and the consent manager notifies this system.
4. The notification becomes a `consent_artefact` row. A staff member at the clinic, looking at her record, sees nothing different: the artefact grants a third party, not them.
5. The data request arrives. Bundles are assembled under a context bound to that consent, encrypted, and pushed. They contain her diagnoses and prescriptions from those six months — **and nothing else**: no notes, no documents, no row dated outside the range.
6. Every row transferred is in the audit trail, and Lakshmi opens the portal and sees the hospital's name, what categories it received, and when.
7. She revokes the consent. A second data request against the same artefact is refused, and the refusal is recorded.
8. Someone points a FHIR client at `/fhir/R4`, reads the `CapabilityStatement`, and fetches her `Condition` resources — seeing exactly what their credentials and the database allow, and nothing more.
9. A hospital asks whether this is ABDM-certified. The documentation answers precisely: what is built, what has run against the sandbox, and what has not been assessed.

---

## Risks specific to SP8

| Risk | Response |
| --- | --- |
| The specification in hand is not the specification the gateway serves — ABDM's APIs have already moved once | One adapter, versioned, with the mock built from the published spec and T38 reconciling it against the sandbox; every difference recorded rather than quietly patched |
| The consent mapping grants more than the artefact said | T19 tests the boundaries in both directions, and DF3 puts the final limit in the database rather than in the code that builds the bundle |
| A record leaves the consent's scope, or the country, through the exchange path | Assembly runs under a bound context; the transfer is audited row by row; residency is S7 and unchanged |
| Building for a certificate nobody has scheduled | The scenario above is the target, not the certificate; T37 states the gap plainly so nothing is claimed early |
| ABHA becomes a second identity system alongside the matching workflow | ABHA is an identifier on the existing patient, never a second patient record; T4 decides the merge cases before they happen |
| The FHIR surface becomes a back door into the clinical record | Read-only by design (DF10), and T29 proves it by extending the sweep that already covers every route |
| A patient with no ABHA becomes a second-class user | DF1, and every existing browser test continues to run against patients who have none |

---

## Open items outside the code

- **ABDM registration**: the facility in the Health Facility Registry, the professionals in the Health Professional Registry, and a registered client with sandbox credentials. None of this can be done from a repository.
- **A pilot hospital willing to be the registered facility** — the same open item SP7 ended on, now blocking something specific.
- **Counsel on ABDM's own obligations**, which sit beside the DPDP Act rather than inside it, and on what a hospital signs to participate.
- **The SNOMED CT licence question** (AA1), still open and still owned.
- **An AWS account**, for T39 and for anything ABDM would ever reach.
- **A decision on who answers a consent dispute** raised through ABDM rather than through the portal — a person, not a service.

---

## Estimate

`planning.md` §14 gives stage 8 no number: "scoped after Milestone B". Scoping it now: **8–12 weeks** for one developer — identity and the adapter about 2 weeks, care contexts and linking about 1.5, the consent mapping about 1.5, the transfer and its crypto about 2, the FHIR surface about 2, the screens about 1, verification and documentation about 1.5. The range is wide for one honest reason: every estimate above assumes the mock is right about the gateway, and T38 exists because it will not entirely be.
