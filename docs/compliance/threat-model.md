# Threat model

What could go wrong at each boundary, and what stops it (sp7-plan.md, T22).

Organised by **trust boundary** rather than by feature, because that is where
things actually go wrong: a request crossing from a browser into the API, a
query crossing from the API into the database, a job crossing from a queue into
a worker. Within a boundary the code trusts itself; at one, it must not.

The rule that most of this rests on: **the database enforces tenancy and
consent, not the application**. Every boundary below is a second line; the first
is that a query with the wrong context returns nothing, whatever the code
asked for (`sp1-plan.md`, `sp3-plan.md`).

What this is not: a penetration test. It is the list of things somebody has
thought about, so that an external tester can spend their time on what nobody
has (`pen-test-scope.md`).

---

## 1. A browser to the API

**Who is on the other side:** a clinician on a shared ward workstation, a
patient on their own phone, and anybody at all.

| Threat | What stops it | Where |
| --- | --- | --- |
| Stolen password used to sign in | A second factor is mandatory for every staff account; the secret is encrypted at rest with a key that can be rotated | `auth.service.ts`, `totp.service.ts` |
| Password guessed online | Per-account lockout growing exponentially with consecutive failures, plus a per-address flood limit | `lockout.ts`, `docs/hardening.md` |
| Account enumeration | One message for an unknown account and a wrong password, and a fake verification so the two take the same time; the patient's sign-in always answers 202 | `auth.service.ts`, `portal-auth.controller.ts` |
| Stolen token replayed | Access tokens live fifteen minutes; refresh tokens rotate, and presenting a used one revokes every session for that user | `session.service.ts` |
| Token forged | Signed and verified with a secret held only in the environment, rotatable without signing anybody out | `config/keys.ts` |
| Script injected into a page reading a token | `sessionStorage`, not a cookie, and a content security policy with no inline or eval'd script | `docs/hardening.md` |
| Clickjacking a consent or a refund | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on both apps | `security-headers.ts` |
| CSRF | No cookies at all: the session travels in an `Authorization` header, so a browser never attaches credentials to a cross-origin request | `app-setup.ts`, `docs/hardening.md` |
| A body large enough to exhaust the process | 256 KB of JSON, 16 KB of form data, refused by the parser | `app-setup.ts` |
| A route nobody meant to expose | Guards are global; a new route is protected unless it opts out, and a sweep fails on any route with no written expectation | `authorization.e2e-spec.ts` |

**Left open, knowingly:** a token in `sessionStorage` is readable by any script
that runs on the page. The content security policy is what stops such a script
existing; moving to an httpOnly cookie is written up in `docs/hardening.md` with
what it would change.

---

## 2. The API to the database

**Who is on the other side:** the application's own unprivileged role.

| Threat | What stops it | Where |
| --- | --- | --- |
| One hospital reading another's record | Row-level security, enabled and **forced**, on every table — a sweep fails on any table without it | `rls-coverage.e2e-spec.ts` |
| A bug in a query leaking rows | The context, not the query, decides: a query with no hospital set returns nothing | `rls.e2e-spec.ts` |
| Consent ignored or expired consent honoured | Consent is evaluated in the policy, by date range and category | `clinical-rls.e2e-spec.ts` |
| SQL injection | Every request-path query is a parameterised Drizzle fragment; `sql.unsafe` exists only in operational scripts, on identifiers validated against a pattern; the one `sql.identifier()` call takes a key of a fixed constant | reviewed 2026-09-28, `security-review.md` |
| The application escalating its own privileges | It is not the owner and cannot be: it has no DDL, cannot read the migration history, and is refused at startup if handed the owner's connection | migration 0066, `config/env.ts` |
| A record quietly altered | Guard triggers refuse an update outside the transitions the domain allows, and refuse deletes outright | `guard_clinical_row`, per-phase specs |
| The audit trail edited | Append-only, enforced by a trigger; a failed write is counted and alerted on | `rls.e2e-spec.ts`, `audit_write_failures_total` |
| Credentials leaked from the environment | In Secrets Manager, injected per task, rotatable | `docs/secrets.md` |

**Left open, knowingly:** the owner's connection can do anything, and it exists
in the migration task. That task runs one command and stops.

---

## 3. The worker and its queues

**Who is on the other side:** Redis, and whatever put a job on it.

| Threat | What stops it | Where |
| --- | --- | --- |
| A forged job doing work nobody asked for | Redis is reachable only from the tasks, over TLS, in a subnet with no internet route | `infra/terraform/data-stores.tf` |
| A job payload used as a path or a command | Payloads carry ids and storage keys; a key is checked against the shape the system generates before it is used | `assertStorageKey` |
| A poisoned job retried forever | Bounded attempts with backoff, and a failure counter exposed as a metric | `scan-queue.ts`, `worker-probe.server.ts` |
| Work silently not happening | Queue depth and failures are scraped from the worker; the sweep behind each queue finds what the queue lost | `worker-probe.server.ts`, `notification-sweep.timer.ts` |
| The worker used as a way in | It has no HTTP API. Its probe port serves two paths and cannot grow a third without somebody writing one | `worker-probe.server.ts` |

---

## 4. Object storage

**Who is on the other side:** a browser holding a presigned URL, and the bucket.

| Threat | What stops it | Where |
| --- | --- | --- |
| Anybody reading a document | The bucket is private, encrypted, TLS-only; every URL is presigned, short-lived, and issued only after the row is read under row-level security and consent | `documents.service.ts`, `data-stores.tf` |
| A hostile file served as something else | The type and length are bound into the upload signature; the download pins `ResponseContentType` to the recorded type | `storage.service.ts`, `docs/hardening.md` |
| A file with malware reaching a clinician | Every upload is scanned before the document becomes available; an unscanned document is never served | `scan.worker.ts` |
| A key walked to another patient's file | Keys are derived from ids and validated before use | `storage/keys.ts` |
| A document surviving an erasure request | The worker may delete objects for exactly this reason, and old versions expire after ninety days | `iam.tf`, `data-stores.tf` |

**Left open, knowingly:** a signature scanner does not stop a targeted document
exploit. Nothing renders these files on the app's own origin, and they are
always served with their recorded type.

---

## 5. The patient portal

**Who is on the other side:** a patient, on a phone, possibly shared.

| Threat | What stops it | Where |
| --- | --- | --- |
| Signing in as somebody else | A code to a number the hospital recorded, with the number's own limit of three codes in fifteen minutes | `otp.service.ts` |
| One household, two records | The phone chooses which record to open, and the session is bound to that patient | `portal-session.service.ts` |
| A staff token used on a patient route, or the reverse | Different audiences, checked; a sweep asserts every staff token is refused on every portal route | `authorization.e2e-spec.ts` |
| A patient reading another's record | The patient context is the policy's input, as the hospital context is elsewhere | `portal-rls.e2e-spec.ts` |
| A guardian keeping access after a child grows up | Handover at the age the policy sets, done by the system rather than by a person remembering | `guardian-handover.timer.ts` |
| An emergency card becoming a permanent key | The token is encrypted at rest, revocable, and every use is recorded and notified | `emergency-card.service.ts` |

---

## 6. The national network (SP8)

**Who is on the other side:** ABDM's gateway, a consent manager, and a
requester nobody here has met. Two directions, and they are not equally
protected — see [abdm.md](../abdm.md) for the full account.

| Threat | What stops it | Where |
| --- | --- | --- |
| A caller answering for the registry, to inject an outcome | An answer must quote a call this process made and is still waiting on; a shared secret and a skew window sit beside it | `gateway/callback-auth.ts` |
| The same, on a request the gateway **starts** | The correlation check cannot apply — there is no call of ours. What is left is a shared secret and the clock, and the gap is closed instead by the next row | `gateway/inbound.controller.ts` |
| **Discovery used as an oracle**, to learn whether somebody is a patient here | The only thing that matches is a **verified** ABHA address the caller already knows. Name, phone and date of birth never match, and every refusal is one indistinguishable refusal | `care-contexts/discovery.service.ts` |
| A visit put on the network without the patient | Nothing is linked until a code comes back; the request's visits are frozen when the patient is asked, so what they approve is what was put to them | `abdm_link_request` guard, migration 0070 |
| A consent granting more than the patient agreed to | The health information types map conservatively, notes are never granted, and the artefact's categories and dates are what the database enforces | `hi-type-mapping.ts`, `app.consent_permits` |
| A bundle carrying more than the consent allows | Assembly runs in a context bound to one consent id; a mistake in the code that builds a bundle cannot widen it | migration 0073, `transfer.service.ts` |
| A transfer continuing after the patient changes their mind | The consent is re-read before every visit; the row records `partly_transferred` and why | `transfer.service.ts`, `abdm-transfer.e2e-spec.ts` |
| Records readable in transit | Ephemeral key agreement per transfer, authenticated encryption, nothing kept that could open it afterwards | `transfer/fidelius.ts` |
| A requester's records leaving unrecorded | Every row transferred is on the patient's audit trail, attributed to the requester and carrying the artefact | `transfer.service.ts` |
| `/fhir/R4` widening access | Same credentials, same permissions, same row-level security; every route in the authorisation sweep | [fhir.md](../fhir.md), `authorization.e2e-spec.ts` |

**What this section does not claim.** That ABDM's own end is secure, that the
requester keeps its undertaking to erase, or that the wire parameters match
the specification — the last is Phase 8's open task and is recorded in
[abdm-certification.md](abdm-certification.md).

---

## 7. Platform and operations

**Who is on the other side:** us.

| Threat | What stops it | Where |
| --- | --- | --- |
| A platform administrator reading a patient record | The role holds no patient permission at all; the permission matrix is a shared constant, and a test asserts it | `permissions.ts`, `authorization.e2e-spec.ts` |
| Emergency access abused | It is recorded with a reason, the patient is told, and the hospital's own administrator reviews the queue | `sp5-plan.md`, break-glass suite |
| A secret leaking through a log | A scrubber between the application and every sink, proved against a real log | `logging.e2e-spec.ts` |
| A secret leaking through an error reporter | Reporting is off by default and scrubbed when on | `error-reporter.ts` |
| A bad deploy serving against the wrong schema | Migrations are a job that is waited for; readiness checks the schema version | `docs/deployment.md` |
| A developer touching production data | There is no path: staging is synthetic, and the owner's credentials live only in the migration task | DF1, `docs/secrets.md` |
| A compromised CI pipeline deploying anything | Deploys are manual, approved through a GitHub environment, and authenticated by OIDC with no stored key | `deploy.yml` |

---

## What is not modelled here

- **The hospital's own network and workstations.** A keylogger on a shared ward
  machine defeats a password and a second factor. Session idle timeout and the
  audit trail limit the damage; nothing here prevents it.
- **A malicious insider with a clinician's account.** They can read what that
  clinician may read. The defence is the audit trail and the review queues,
  which is detection rather than prevention — and that is the honest position
  for any clinical system.
- **Denial of service at scale.** Rate limits stop a single caller; an actual
  flood is the load balancer's and the cloud's problem, and is not configured
  yet.
- **Supply chain beyond scanning.** Dependencies are scanned and pinned by a
  lockfile; nothing verifies what a maintainer published.
- **What a national requester does with what it received.** A transfer is not
  recallable, and the consent's erase-by date is an undertaking this system
  cannot enforce.
