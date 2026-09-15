# SP5 — Patient Portal and Consent: Implementation Plan

**Status:** Approved for building. Decisions I–N answered 2026-09-15: **I1, J1, K1, L1, M1, N1**. No SP5 code has been written.
**Scope:** Patient sign-in by phone and OTP; the patient's own record across every hospital, in plain language; reports and results; consent granted and revoked by the patient; access history; break-glass notification; the emergency card; dependants; and the patient's rights under the DPDP Act — export, correction and erasure requests.
**Design reference:** `planning.md` D12, §6.4, §8, §10, §11 · `features.md` SP5 and Cross-cutting · `sp3-plan.md` (consent, break-glass) · `sp4-plan.md` (documents, results, DF6)

---

## 0. Decisions for you

**Answered 2026-09-15: I1, J1, K1, L1, M1, N1** — a separate portal app; access activated at a hospital desk; patients grant and revoke consent themselves; a printed emergency card with a QR to a live page; children linked to a guardian until 18; export as PDF and FHIR with correction and erasure as reviewed requests. The options considered are kept below for the record.

### Decision I — Where the portal lives

`planning.md` §10 says the portal is "same codebase, separate route tree and auth surface, mobile-first".

| Option | What it means | Trade-off |
| --- | --- | --- |
| **I1. A separate app in the monorepo, `apps/portal`** _(recommended)_ | Its own React + Vite build, mobile-first, installable as a web app. Shares types, schemas and the API with the clinical app through `packages/shared`. | No staff screen, permission or clinical-entry code ever ships to a patient's phone, and the bundle stays small on slow mobile networks. Two apps to build and deploy. |
| I2. A route tree inside the clinical app | `/portal/...` routes in `apps/clinical`, with a second sign-in. | One deployment. The clinical app's desktop layout, offline cache and staff code are downloaded by every patient, and a routing mistake can expose a staff screen to a patient session. |

### Decision J — How a patient account comes to exist

An OTP proves that someone holds a phone, not that they are the patient. In India one phone often serves a whole family, and `patient.phone` is not unique — a sign-up that matches on phone alone would hand one person's record to another.

| Option | What it means | Trade-off |
| --- | --- | --- |
| **J1. Activated at a hospital desk** _(recommended)_ | The front desk or records staff, with the patient in front of them, confirm identity as they do at registration and activate portal access for a phone number. The patient then signs in with OTP. One phone may hold several activated patients (a family), each chosen after sign-in. | Identity is proved by a person who can see the patient, the same way the record itself was created. The patient must visit a linked hospital once. |
| J2. Self sign-up with OTP and date of birth | Anyone with a registered phone number signs up by entering the patient's date of birth. | No visit needed. Family members share phones and know each other's birth dates, so it proves little; a mistaken match exposes a whole medical history. |
| J3. Self sign-up through ABHA | Identity verified by ABDM through the patient's ABHA number. | Strong, national identity. Requires ABDM sandbox registration and certification (M1/M2) before any patient can use it; most patients in scope have no ABHA yet. A later addition to J1, not a replacement. |

### Decision K — Whether patients grant consent themselves

Today consent is recorded at the desk (SP3 Decision A1).

| Option | What it means | Trade-off |
| --- | --- | --- |
| **K1. Patients grant and revoke from the portal; the desk path stays** _(recommended)_ | A patient chooses a hospital they are linked to, the categories, an optional date range and an expiry, and grants — or revokes any consent, including one recorded at the desk, with immediate effect. Recorded as `capture_method = patient_portal`. | The consent-manager experience `features.md` describes. The desk remains for patients without smartphones. |
| K2. Patients see and revoke only; granting stays at the desk | The portal lists consents and revokes them. | Simpler. A patient who wants to share must go to the hospital, which is where the friction is. |
| K3. K1, plus hospital consent requests | A hospital asks; the patient approves in the portal. | The ABDM-style flow. A request inbox, notifications and expiry of requests roughly add a phase; better after K1 is in use. |

### Decision L — The emergency card

`features.md`: "readable by any casualty department without login".

| Option | What it means | Trade-off |
| --- | --- | --- |
| **L1. A printed card with the essentials on it, and a QR code to a live emergency page** _(recommended)_ | The patient chooses what the card shows (blood group, allergies, current medicines, chronic conditions, emergency contact). The card prints those facts; its QR opens a read-only page with the same facts kept current. The page link is a long random token the patient can revoke and replace; every opening is audited and rate-limited. | Works without a network (the printed facts) and stays current when there is one (the page). A lost card is revoked from the portal. |
| L2. Everything encoded in the QR itself | The QR carries the data; no server involved. | Works offline anywhere, but cannot be revoked, goes stale, and anyone who photographs it has the data forever. |
| L3. The live page only | No printed facts. | Always current; useless in a casualty department with no signal. |

### Decision M — Dependants in SP5

The DPDP Act requires verifiable consent from a parent or guardian to process a child's data.

| Option | What it means | Trade-off |
| --- | --- | --- |
| **M1. Children under 18, linked to a guardian at the desk** _(recommended)_ | Records staff link a child's record to a guardian's account after checking the relationship. The guardian sees the child's record and manages the child's consents. At 18 the guardian's access ends automatically and the young adult is invited to activate their own account (J1). | Covers the legal requirement and the common case. |
| M2. M1 plus adults by proxy (elderly parents) | An adult's record managed by a relative under a documented authorisation. | Real need, but the authority to act for an adult needs counsel's advice on documents and revocation. |
| M3. No dependants in SP5 | Each account is one patient. | Smaller SP5. Parents cannot use the portal for their children, a large share of hospital visits. |

### Decision N — DPDP rights: export and erasure

Clinical records are never deleted (SP3 S3, SP4 DF6), while the DPDP Act gives a right to erasure subject to other laws requiring retention.

| Option | What it means | Trade-off |
| --- | --- | --- |
| **N1. Export as PDF and FHIR R4 bundle; correction and erasure as reviewed requests** _(recommended)_ | The patient downloads a human-readable PDF of their whole record and a FHIR R4 JSON bundle. Demographic corrections go to the registering hospital's records staff as a queue. Erasure is a request reviewed by a Health24 data-protection officer (a new platform role that never reads clinical content), who applies documented retention exceptions: clinical records are retained as law requires; portal account, consents not in force, contact details and the emergency card are erased; the outcome is recorded and told to the patient. | Meets the rights with a workflow counsel can review. Building FHIR export here also lays the first part of the `/fhir/R4` surface in `planning.md` §10. |
| N2. PDF export only; erasure deferred to counsel | Export as PDF; the rest later. | Faster. The erasure right is unmet until counsel's advice is turned into a workflow. |

---

## Defaults taken

Technical choices with a clear best answer. Each is reversible; say if you disagree.

| # | Default | Why |
| --- | --- | --- |
| DF1 | **OTP:** six digits, valid five minutes, five attempts, stored only as a hash; at most three requests per phone per 15 minutes and a per-IP limit; the same response whether or not a number has an account. | Stops enumeration and brute force; a hashed OTP is useless if the table leaks. |
| DF2 | **An SMS provider behind an interface**, with a development provider that writes the OTP to the API log. The production provider (MSG91, Gupshup or AWS SNS) and its TRAI DLT templates are chosen before the pilot. | Code and tests do not wait on a commercial account; DLT registration is required in India for any transactional SMS. |
| DF3 | **Patient sessions are their own table and token audience.** Access tokens carry `aud: patient`; the staff guards refuse them and the portal guards refuse staff tokens. Refresh tokens as for staff: opaque, hashed, revocable, listed in the portal. | A patient token can never reach a staff route by mistake, and a lost phone can be cut off. |
| DF4 | **Row-level security gains a patient context**, `app.current_patient_id`. In it, every clinical, document and result policy admits rows of that patient's record ids — at every hospital, with no consent needed, because it is the patient's own data. Consent artefacts are readable and revocable by their patient; `access_log` is readable for rows about that patient. | The database, not application code, keeps one patient out of another's record, as it keeps one hospital out of another's. |
| DF5 | **Plain language from designations, never invented.** The portal shows a diagnosis by a patient-friendly designation where the terminology holds one, otherwise by its coded display with the system named; medicines as prescribed; lab values with "higher/lower than the lab's range". No explanations are generated. | Plain-language text is clinical content and needs the clinical reviewer (`planning.md` §15 Q3); shown only where curated. |
| DF6 | **Portal reads are audited as the patient**: `actor_type = patient`. The access history shows the patient everyone else's reads — staff name, role, hospital, what, when, and the consent or emergency access it rested on — and omits the patient's own. | `planning.md` §6.4; the patient's own reads would drown the history. |
| DF7 | **Downloads are presigned links as in SP4**, issued to the patient for their own documents at any hospital, audited as exports. | One file path for staff and patients. |
| DF8 | **Internationalisation from day one, English first**: every portal string in a message catalogue (i18next), dates and numbers in `en-IN`, IST. | `features.md` Cross-cutting; retrofitting i18n costs far more than starting with it (`planning.md` §15 Q6). |
| DF9 | **WCAG 2.2 AA** for the portal, checked with axe in the end-to-end tests; 44-pixel touch targets; works on a 360-pixel-wide screen. | `features.md` Cross-cutting. |
| DF10 | **Break-glass notification:** an SMS to the patient's activated phone and an alert in the portal, sent by a queued job when emergency access is taken; `patient_notified_at` is set when the SMS is accepted by the provider. | `planning.md` §8: unaudited or unannounced break-glass makes consent decorative. |

---

## Decisions already made

| # | Decision | Source |
| --- | --- | --- |
| S1 | Patients sign in with phone number and OTP; no patient password. | `planning.md` D12 |
| S2 | The portal is mobile-first, with its own auth surface. | `planning.md` §10 |
| S3 | Consent is by data category, date range and expiry; revocation takes immediate effect. | `planning.md` §8, `features.md` SP5 |
| S4 | `access_log` records reads and is append-only; it is what lets a patient ask who looked at their record. | `planning.md` §6.4 |
| S5 | Clinical records are never edited or deleted; corrections are new versions. | `sp3-plan.md` S3, `sp4-plan.md` DF6 |
| S6 | No clinical decision support: the portal reports, it does not advise. | `features.md` excluded list |
| S7 | `patient_account` exists since SP1; its unused `password_hash` column is dropped. | `apps/api/src/db/schema/patients.ts` |

---

## Definition of done

1. A patient whose portal access was activated (Decision J) signs in with phone and OTP, chooses among the patients activated on that phone, and can list and end their sessions.
2. The patient sees their own summary, timeline, medicines, problems, allergies, reports and lab trends across every hospital, in plain language, and downloads any report through an audited short-lived link.
3. The patient grants a linked hospital consent by category, date range and expiry, and revokes any consent with immediate effect (Decision K); the history of every grant and revocation is shown.
4. The patient sees who read their record: staff, role, hospital, what, when, and under which consent or emergency access.
5. When emergency access is taken, the patient is told by SMS and in the portal.
6. The emergency card prints and opens as decided (Decision L); every opening is audited; a card can be revoked.
7. Dependants work as decided (Decision M), including the hand-over at 18.
8. Export, correction and erasure work as decided (Decision N).
9. Row-level security proves a patient reaches only their own record, and no patient token reaches a staff route or a staff token a portal route; the authorisation suite classifies every new route; the portal passes axe with no serious violations.
10. The acceptance scenario below passes end to end.

---

## Design

### Identity and sign-in

```
patient_account     id, phone (E.164, unique), status(active|suspended),
                    created_at, last_login_at
patient_portal_access  account_id, patient_id, relationship(self|guardian),
                    activated_by_staff_id, activated_at, ends_at?,
                    revoked_at?, revoked_by?, revoked_reason?
otp_challenge       id, phone, code_hash, purpose(sign_in), attempts,
                    expires_at, consumed_at, ip_address, created_at
patient_session     id, account_id, patient_id, refresh_token_hash,
                    issued_at, expires_at, last_used_at, revoked_at,
                    ip_address, user_agent
```

`patient_account` becomes the phone's account, and `patient_portal_access` the patients it may act for — one row per family member activated on the phone (J1), or per child for a guardian (M1). `ends_at` is a child's 18th birthday. A session is for one patient at a time; switching patient issues a new session.

Routes: `POST /portal/auth/otp` (request), `POST /portal/auth/verify`, `POST /portal/auth/refresh`, `POST /portal/auth/select-patient`, `GET /portal/auth/sessions`, `DELETE /portal/auth/sessions/:id`, `POST /portal/auth/logout`. Staff side: `POST /patients/:id/portal-access` (activate), `GET /patients/:id/portal-access`, `POST /portal-access/:id/revoke`.

### The patient context in the database

Every existing read policy gains one branch:

```
OR app.current_patient_id() IS NOT NULL
   AND "patient_id" = ANY (app.patient_record_ids(app.current_patient_id()))
```

The patient context is set only by the portal's request pipeline and is never combined with a hospital context. Writes in patient context are limited to consent artefacts (grant, revoke), correction and erasure requests, emergency-card settings and portal sessions — each by its own policy.

### Portal API

Under `/api/v1/portal`, patient tokens only:

- `summary`, `timeline`, `medications`, `problems`, `allergies`, `documents`, `documents/:id/files/:fileId/url`, `results`, `results/trends`
- `hospitals` (those the patient is linked to), `consents` (list, grant, revoke)
- `access-history` (paged; filter by hospital and period)
- `notifications` (break-glass and consent events)
- `emergency-card` (settings, token rotation, print data)
- `dependants` (M1), `export` (N1), `correction-requests`, `erasure-requests`

The existing services are reused with a patient actor: the timeline, summary, results and documents services already take an actor and rely on row-level security for visibility.

### Consent from the portal (K1)

`consent_artefact` gains `capture_method = patient_portal` and `recorded_by_patient_account_id`; `recorded_by_staff_id` becomes nullable with a check that exactly one recorder is set. The hospital's sharing screen shows which consents the patient granted in the portal.

### Access history

A query over `access_log` for the patient's record ids, excluding `actor_type = patient` rows by that account, joined to staff names and roles and hospital names. Grouped by day and actor in the portal. Break-glass reads carry their reason. Terminology curators and platform admins never read records, so they never appear.

### Emergency card (L1)

```
emergency_card      patient_id, token_hash, fields[], created_at,
                    rotated_at, revoked_at
```

`GET /api/v1/emergency/:token` is public, rate-limited, returns only the chosen fields, and writes an audit row (`actor_type = system`, `resource_type = emergency_card`, IP and user agent). The portal renders a printable wallet card (credit-card size, PDF) and a lock-screen image (PNG) with the facts and the QR.

### Dependants (M1)

Guardian links are created by records staff with the relationship and the document checked (recorded as text, not uploaded, unless the hospital uploads it as a document). A daily job ends access at 18 and invites the young adult by SMS to activate at a desk.

### DPDP rights (N1)

- **Export:** a queued job builds the PDF (every entry, in date order, with hospital and clinician) and a FHIR R4 `Bundle` of type `collection` (Patient, Encounter, Condition, MedicationRequest, AllergyIntolerance, Observation, Procedure, DocumentReference with links issued at download). Delivered as a one-hour download link; audited as an export by the patient.
- **Correction:** a request naming the field and the correct value goes to the registering hospital's merge-and-correction queue; records staff apply it through the existing demographic change with the request as the reason.
- **Erasure:** a request goes to the data-protection officer's queue. The decision, the retention exceptions applied and what was erased are recorded and shown to the patient. Nothing clinical is deleted.

### The portal app (I1)

`apps/portal`: React, Vite, TanStack Query, react-router, i18next; installable web app (manifest, no offline clinical cache in SP5). Screens: sign in (phone → OTP), choose patient, home (summary), timeline, reports, results and trends (the SP4 chart, re-used through a shared component package or copied with its tests), consents, access history, notifications, emergency card, family, my data (export, correction, erasure), sessions.

---

## Tasks

### Phase 1 — Patient identity and sign-in

- [x] **T1** Migrations: `patient_account` rework, `patient_portal_access`, `otp_challenge`, `patient_session`; `app.current_patient_id` and the patient branch in every read policy; consent recorder by patient — migrations 0031–0033. `patient_account` is now the phone (its patient and password columns dropped); `patient_portal_access` carries the phone, the hospital and staff who activated it, and a once-only revocation; codes and sessions are system-context only. `app.is_own_record` admits a patient's rows across merged record ids only in a patient context and never beside a hospital's, and is added to the eight clinical and document read policies and to `patient`, `patient_hospital_link`, `consent_artefact` and `access_log`. The desk creates an account through `app.portal_account_for_phone`, which cannot list accounts. The consent recorder by patient moves to T11, where patients first write consents
- [x] **T2** OTP service and SMS provider interface with the development provider; rate limits (DF1, DF2) — six digits, five minutes, five attempts, stored as an HMAC keyed by the server secret; every request creates a challenge and only a number with access is sent the code, so a stranger's number gets the same answer and the same three-per-15-minutes limit; 30 requests a minute per address. `SMS_PROVIDER=log` writes messages to the API log and is the default outside production; production refuses it at startup, and with no provider configured the API starts but refuses to send (503) rather than writing a code anywhere else
- [x] **T3** Portal auth routes, patient token audience and guards (DF3); desk activation routes and screen in the clinical app (J1) — `/portal/auth` otp, verify, session, refresh, me, switch, sessions, logout; staff tokens now carry the audience `health24-staff` and portal tokens `health24-portal`, so each is refused by the other's routes; `@PortalRoute()` routes admit only a live patient session with its access still in force. Staff `POST/GET /patients/:id/portal-access` and `POST /portal-access/:id/revoke` under the new permission `portal:activate` (front desk, records staff, clinicians); revoking ends the portal's sessions for that patient at once. A "Patient portal" card on the patient's Overview activates with an in-person identity confirmation, lists and revokes
- [x] **T4** Row-level security suite for the patient context; authorisation suite for patient and staff tokens on both surfaces — `portal-rls.e2e-spec.ts` (8), `portal-auth.e2e-spec.ts` (11); the authorisation suite classifies the twelve new routes and refuses every staff token on every portal route

### Phase 2 — The portal app

- [x] **T5** `apps/portal` scaffold: build, routing, i18n catalogue, accessibility baseline, CI
- [x] **T6** Sign-in, patient choice, sessions screen
- [x] **T7** Home: the summary card in plain language (DF5)

### Phase 3 — The patient's own record

- [x] **T8** Portal record API over the existing services with a patient actor; audit as patient (DF6)
- [x] **T9** Timeline, medicines, problems and allergies screens
- [x] **T10** Reports list and download (DF7); results and trends

### Phase 4 — Consent

- [x] **T11** Consent grant and revoke API for patients (K1)
- [x] **T12** Consent screens and history; the hospital's sharing screen shows portal-granted consents

### Phase 5 — Access history and notifications

- [x] **T13** Access history API and screen (DF6)
- [x] **T14** Break-glass notification: job, SMS, portal alert, `patient_notified_at` (DF10)

### Phase 6 — Emergency card

- [ ] **T15** Card settings, token, public endpoint with rate limit and audit (L1)
- [ ] **T16** Printable wallet card and lock-screen image

### Phase 7 — Dependants

- [ ] **T17** Guardian links at the desk; acting for a child in the portal (M1)
- [ ] **T18** The hand-over at 18

### Phase 8 — Rights under the DPDP Act

- [ ] **T19** Export: PDF and FHIR R4 bundle (N1)
- [ ] **T20** Correction requests into the records queue
- [ ] **T21** Erasure requests: the data-protection officer role, queue and recorded outcome

### Phase 9 — Verification

- [ ] **T22** Unit and integration: OTP limits and expiry, token audiences, every new route, row-level security for patients and guardians
- [ ] **T23** Portal end-to-end tests with Playwright, and axe accessibility checks (DF9)
- [ ] **T24** The acceptance scenario below, and a browser check on a phone-sized screen

---

## The acceptance scenario

Continuing the Amlapitta scenario from SP3 and SP4:

1. At Sanjeevani the front desk activates portal access for Lakshmi's phone. She signs in with an OTP and sees her Amlapitta diagnosis, her formulations, her penicillin allergy, the old LFT and the ultrasound — without any consent, because they are hers.
2. She grants City General consent for diagnoses, medicines, allergies and observations for six months — not documents.
3. The gastroenterologist opens her timeline. In her access history Lakshmi sees his name, City General, the categories read, and the consent it rested on.
4. A casualty doctor at City General takes emergency access to read her documents. Lakshmi receives an SMS and a portal alert, and the access shows its reason in her history.
5. She revokes the consent from her phone; the gastroenterologist immediately sees nothing from Sanjeevani.
6. Her emergency card, opened from its QR without signing in, shows her blood group and the penicillin allergy, and the opening appears in her access history.
7. She downloads her record as a PDF and a FHIR bundle.

---

## Risks specific to SP5

| Risk | Response |
| --- | --- |
| The wrong person reads a record through a shared family phone | Access activated in person (J1); patient chosen after sign-in; sessions listed and revocable; access history visible to the patient |
| OTP brute force, SIM swap, SMS interception | Hashed short-lived OTPs, attempt and request limits, same answer for unknown numbers, new-device SMS notice; ABHA or TOTP as a second factor later |
| SMS delivery failure in rural areas | Retry with backoff; OTP resend limits that allow one fallback; the desk can still read the record for the patient |
| Plain-language wording that misleads | Only curated patient-friendly designations; coded display otherwise; clinical reviewer signs off wording (DF5) |
| Emergency card data outliving its accuracy | Printed date on the card; live page always current; revocation from the portal |
| A child's record visible to a former guardian | Access ends automatically at 18; links revocable by records staff; recorded in the access history |
| Erasure expectations beyond what retention law allows | The outcome states what was erased and what must be retained and why; counsel reviews the retention exceptions |
| Two apps for a solo developer | Shared packages for types, schemas and the chart; Phases 6–8 can follow the pilot if time runs short |

---

## Open items outside the code

- **SMS provider** account and **TRAI DLT** registration of the sender ID and OTP, break-glass and consent templates.
- **Counsel** on the DPDP Act: verifiable parental consent for children, the retention exceptions for erasure, the data-protection officer, and the privacy notice shown at activation.
- **Clinical reviewer** for patient-friendly designations and portal wording.
- **ABDM** sandbox registration, if ABHA sign-in (J3) is wanted after SP5.
- **Domain and certificates** for the portal and the public emergency page.

---

## Estimate

`planning.md` §14 gives SP5 **6–9 weeks** for one developer. With I1, J1, K1, L1, M1 and N1: identity and sign-in about 1.5 weeks, the portal app and own record about 2 weeks, consent and access history about 1.5 weeks, the emergency card about 0.5 weeks, dependants about 1 week, DPDP rights about 1.5 weeks, and verification throughout. K3, M2 or J3 would each add roughly a week.
