# SP7 — Production readiness and compliance: Implementation Plan

**Status:** Building. Decisions U–W answered 2026-09-25: **U1, V1, W1**. Phase 1 complete.
**Scope:** What stands between a system that works on a developer's machine and one that may hold a real patient's record: configuration and secrets, logs that never leak a patient, health and readiness, security headers and rate limits, container and infrastructure definitions for AWS Mumbai, backups with a restore drill that is actually run, a threat model and automated scanning in CI, the runbooks somebody follows at three in the morning, and an honest self-assessment against the DPDP Act and the EHR Standards.
**Design reference:** `planning.md` §11 (security, privacy, compliance), §13 (infrastructure), §14 stage 7 · `sp1-plan.md` (tenancy, auth, audit) · `sp5-plan.md` (the patient's rights, erasure, exports) · `sp6-plan.md` (what the system now holds)

**What this sub-project is not.** It is not ABDM — ABHA linking and the HIP/HIU adapters are SP8, and they need a deployed, secured system to certify. It is not a legal workstream: counsel, the data-processing agreements and the licensing questions are listed at the end as work outside the code, because no amount of TypeScript settles them.

---

## 0. Decisions for you

**Answered 2026-09-25: U1, V1, W1** — production readiness and compliance before ABDM; infrastructure written as code and verified locally rather than applied to a cloud account; an internal threat model and checklist beside automated scanning. The options considered are kept below for the record.

### Decision U — What SP7 builds

| Option                                                    | What it means                                                                                                                                                                                                         | Trade-off                                                                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U1. Production readiness and compliance** _(chosen)_    | Deployment artifacts, secrets, observability, hardening, backups and restore, scanning in CI, runbooks, and a self-assessment against the regimes that apply. ABDM becomes SP8.                                       | The order `planning.md` §14 gives. Nothing here is visible to a clinician, which makes it the easiest work to skip and the most expensive to skip — a breach runbook written after a breach is not a runbook. |
| U2. ABDM integration first                                | ABHA linking, HIP and HIU adapters, the consent manager, sandbox certification.                                                                                                                                       | The clearest differentiator, and the thing a hospital asks about. Certification is against a deployed system with a security posture, so it would need most of U1 anyway, done in a hurry. |
| U3. A minimum of both                                     | Enough deployment and observability to run somewhere, then straight to ABDM.                                                                                                                                          | Fastest to something demonstrable. It leaves backups, runbooks and the compliance position half-done, which is exactly the half that matters the first time something goes wrong.        |

### Decision V — How far deployment goes

| Option                                                          | What it means                                                                                                                                                                                                                       | Trade-off                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1. Infrastructure as code, verified locally** _(chosen)_     | Dockerfiles for every service, a production compose profile that runs the whole stack locally, and Terraform for AWS `ap-south-1` — VPC, RDS multi-AZ with point-in-time recovery, ECS Fargate, S3 with encryption and versioning, Secrets Manager, CloudWatch. Formatted, validated and planned in CI against no real account; applied by a person with credentials when there is one. | Everything is written, reviewed and reproducible, and costs nothing until someone decides to spend. What it cannot prove is that the cloud accepts it — the first real apply will find something. |
| V2. A single server                                            | One VM, docker compose, a managed Postgres beside it.                                                                                                                                                                              | Fewer moving parts and cheaper to run. It steps away from the multi-AZ, point-in-time-recovery posture `planning.md` §13 commits to, and a pilot hospital's data would sit on one machine. |
| V3. Apply to a real account                                    | Stand up staging in AWS for real.                                                                                                                                                                                                  | The only way to know it works. It needs an account, a card, and credentials — which I would never enter; you would. Worth doing when a pilot is close.                            |

### Decision W — How the security review is done

| Option                                                                | What it means                                                                                                                                                                                                                | Trade-off                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1. Threat model and checklist, beside automated scanning** _(chosen)_ | A written threat model per trust boundary, a checklist run against the code with findings recorded and fixed or accepted in writing, dependency, secret and container scanning in CI, and a pen-test scope document ready for whoever is engaged later. | Finds the things scanners cannot: a missing authorisation path, a leak through an error message, a consent check in the application rather than the database. It is not a substitute for an external test, and says so. |
| W2. Automated scanning only                                            | Scanners in CI, nothing written down.                                                                                                                                                                                       | Cheap and immediate. Scanners find known-vulnerable dependencies, not design mistakes, and leave nothing for an auditor to read.                                      |
| W3. Defer security work                                                | Deployment and runbooks only.                                                                                                                                                                                               | Smaller. It would mean asking a hospital to trust a system nobody has looked at adversarially.                                                                        |

---

## Defaults taken

Where the plan does not need a decision from you, these are the positions taken. Each is a rule the code and the documents are held to.

| #    | Default                                                                                                                                                                                                       | Why                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DF1  | **No real patient data outside production.** Staging and local are synthetic, always; there is no import path from production into either, and nothing in the repo can be pointed at a production database by accident. | `planning.md` §13. The cheapest breach to prevent is the one where a copy of the record is sitting in a test environment.                                  |
| DF2  | **Configuration comes from the environment and is validated at boot.** A missing or malformed secret stops the process with a message naming what is wrong; nothing falls back to a default in production.    | A system that starts with a weak default is worse than one that refuses to start.                                                                          |
| DF3  | **Secrets live in a managed store, never in the repository or an image.** The repo carries names and shapes; the values are injected. Rotation is a documented procedure that the code supports.              | `planning.md` §11. Rotation that requires a redeploy nobody has rehearsed is rotation that never happens.                                                  |
| DF4  | **Logs carry identifiers, never people.** Structured JSON with a request id, hospital id, staff or patient id and route — never a name, an MRN, a phone number, a diagnosis or free text. A scrubber sits between the application and every sink, and a test proves it. | A log aggregator is a second copy of the record if nobody stops it being one. The audit trail is where reads and writes are recorded; logs are for operating the system. |
| DF5  | **The audit trail and the logs are separate things.** Nothing moves the audit trail into a log sink, and nothing in the logs is relied on for the audit obligation.                                           | `planning.md` §6.4 and §11: one is a legal record with retention, the other is operational exhaust.                                                        |
| DF6  | **Health and readiness are different questions.** Health says the process is alive; readiness says the database, Redis and object storage are reachable and migrations are at the expected version. A version endpoint names the build. | A load balancer that sends traffic to a process which cannot reach its database is worse than one that waits.                                              |
| DF7  | **A backup nobody has restored is not a backup.** The drill is a script anybody can run, it is run in CI against a synthetic dump, and the documented RPO and RTO come from what the drill actually takes.    | `planning.md` §11 states the rule; this makes it something that can fail a build.                                                                          |
| DF8  | **A failing scan fails the build.** Dependency, secret and container scanning run in CI; a high-severity finding stops the pipeline, and an accepted risk is written down with a date and a reason rather than silently ignored. | An advisory nobody reads is not a control.                                                                                                                 |
| DF9  | **Runbooks live in the repository, in `docs/runbooks/`,** written for somebody who did not build the system and is reading at three in the morning: what to check, in order, and what to say to whom.         | A runbook in somebody's head fails exactly when it is needed.                                                                                              |
| DF10 | **The compliance position is written down with its gaps.** Each requirement of the DPDP Act and the EHR Standards is mapped to where the system satisfies it, or listed as an open item with an owner. Nothing is claimed that the code does not do. | An honest gap list is a plan; a clean sheet that is not true is a liability, and the first person to find out is a regulator.                              |

---

## Decisions already made

Carried in from earlier sub-projects and not reopened here.

| #   | Decision                                                                                            | Source                       |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------- |
| S1  | Clinical rows are never edited or deleted; a correction is a new version.                           | `sp3-plan.md` S3             |
| S2  | Every read and write is audited; the audit trail is append-only.                                    | `planning.md` §6.4           |
| S3  | Row-level security binds to an unprivileged role; tenancy and consent are enforced by the database. | `sp1-plan.md`, `sp3-plan.md` |
| S4  | Dates that a person reads are India Standard Time; instants are stored with a time zone.            | `sp3-plan.md`                |
| S5  | Background work runs on queues with a sweep behind it, never in the request.                        | `sp4-plan.md`, `sp5-plan.md` |
| S7  | Data residency is India: storage and processing in `ap-south-1`.                                    | `planning.md` §11, §13       |

---

## Definition of done

1. The API, the worker and both apps build as containers that run as a non-root user, carry a healthcheck, and start from configuration alone.
2. `docker compose -f docker-compose.prod.yml up` brings the whole stack up locally from those images, migrations included, and the smoke scripts pass against it.
3. The Terraform for `ap-south-1` is formatted, validated and planned in CI, and describes: VPC with private subnets, RDS PostgreSQL multi-AZ with point-in-time recovery, ECS Fargate services for the API and worker, S3 with encryption, versioning and public access blocked, Secrets Manager, and CloudWatch log groups with retention.
4. Every log line is structured JSON, carries a request id, and a test proves that a name, an MRN, a phone number and clinical text cannot reach a log sink.
5. `/health`, `/ready` and `/version` answer correctly, and readiness fails when the database, Redis or storage is unreachable.
6. Security headers, CORS and rate limits are applied and tested: HSTS, a content security policy for both apps, frame and content-type options, a global request limit and a stricter one on authentication.
7. A restore drill script restores a dump into a scratch database and boots the application against it; CI runs it, and the measured RPO and RTO are written into the runbook.
8. CI fails on a high-severity dependency, secret or container finding, and the accepted-risk file explains anything deliberately allowed.
9. `docs/runbooks/` holds the breach-notification, restore, key-rotation, incident-response and on-call runbooks, each walked through once and corrected from what that found.
10. `docs/compliance/` holds the DPDP Act and EHR Standards self-assessment, the threat model, the checklist findings and the pen-test scope, with every gap listed.
11. The acceptance scenario below passes.

---

## Phases and tasks

### Phase 1 — Configuration, secrets and rotation

- [x] **T1** Audit every environment variable: required or optional, its shape, and what happens when it is missing (DF2)
- [x] **T2** Fail-fast validation at boot for the API, the worker and both apps' build-time configuration, with messages that name the variable
- [x] **T3** The secret store contract: what production injects, from where, and what the repository may never contain (DF3)
- [x] **T4** Key rotation the code supports — the TOTP encryption key and the JWT signing secret, each with a documented procedure and a test that both the old and the new key work through the overlap

**Most of the validation was already there; what it let through was not.** The
schema refused a development JWT secret in production and storage outside
Mumbai, but accepted an encryption key of the right length that was not a key,
started in production without Redis — so uploads went unscanned and patients
untexted, silently — and let static storage credentials and the owner database
connection sit in the environment of a task that should have neither. Each of
those is now a refusal with a message naming the variable, and
`config/env.spec.ts` holds a case for every one.

**The documentation cannot drift.** `docs/configuration.md` lists every
variable, and a test reads both it and the schema and fails if either holds a
name the other does not. Documentation that quietly goes stale is worse than
none: somebody sets the system up from it, believes they are finished, and
finds out in production.

**Both keys rotate without an outage.** They are read as a pair — the key in
force, then the one it replaced — so a rotation is: set both, deploy, rewrite
the rows, withdraw the old one. Tokens need no rewrite because they expire;
secrets at rest do, which is what `keys:rewrap` is for, and it is safe to run
twice and refuses to declare success while any row is unreadable. The whole
procedure is walked by `test/key-rotation.e2e-spec.ts` against a real
database, including the part that matters most: that a second factor stored
under the old key still opens the door during the overlap. Without that, a
rotation ends with an administrator re-enrolling every member of staff by hand.

**The apps have no secrets to validate**, which is stated in the documentation
rather than papered over with configuration that does nothing: they are static
builds behind a proxy, and anything a browser can read is not a secret.

### Phase 2 — Observability

- [x] **T5** Structured JSON logging with a request id, and the scrubber between the application and every sink (DF4)
- [x] **T6** A test that proves a name, an MRN, a phone number and clinical text cannot reach a log line
- [x] **T7** Error reporting behind an interface, off unless configured, with the same scrubbing and no PHI in a stack trace
- [x] **T8** `/health`, `/ready` and `/version`, with readiness checking the database, Redis, storage and the migration version (DF6)
- [x] **T9** The few metrics worth having at this size: request rate and latency by route class, queue depth and job failures, and the audit-write failure counter

**The scrubber is in the way, not in the instructions.** It sits in pino's
`logMethod` hook, so every line is scrubbed on the way out whatever the caller
wrote — by key and by shape, because the leak that actually happens is a value
interpolated into a message, not a field somebody named `name`. A rule that
each caller has to remember is broken the first busy afternoon after somebody
new joins.

**The proof is a real log, not a mock.** `test/logging.e2e-spec.ts` registers a
patient, searches for her by name, looks her up by phone, fails a validation
with her details in the body, and records an encounter with a chief complaint —
then reads every line the application wrote and asserts her name, phone, MRN,
date of birth and complaint are in none of them, while her id, the route and
the status are.

**Liveness and readiness were one endpoint, and that was wrong.** `/health`
now touches nothing — restarting a process will not fix a database — and
`/ready` asks the database, the migrations, Redis and storage, each with its
own timeout, and answers 503 naming which one is down.

**Readiness found a boundary rather than crossing it.** The migration check
could not read `drizzle.__drizzle_migrations`, because SP1 deliberately keeps
the application role out of the migration history and `rls.e2e-spec.ts`
asserts it. Migration 0066 adds `app.schema_version()`, a SECURITY DEFINER
function with a pinned `search_path` that returns a count and nothing else: the
probe learns a number, not a history.

**Two bugs the tests found, both of which would have been ugly in production.**
A global exception filter built with `useFactory` gets no HTTP adapter — the
adapter does not exist when the module is compiled — so it caught every 4xx and
wrote no response at all: every refused request hung until the client gave up.
And the route-classification sweep in `authorization.e2e-spec.ts` began failing
because the request-logging middleware registers as a route answering every
method; it now tells middleware from endpoints, which keeps the sweep's real
job intact.

**Metrics are counted in the process, not by a library.** Two http series and
one counter worth alerting on — `audit_write_failures_total`, the failure that
leaves the record readable and the trail of who read it missing. Route labels
are patterns, never real ids, which bounds the cardinality and keeps a
patient's id off a dashboard kept for a year. Queue depth waits for Phase 4,
where the worker gets a port to scrape.

### Phase 3 — Hardening the edge

- [x] **T10** Security headers on both apps and the API: HSTS, a content security policy written for each app, frame options, content-type options, referrer policy
- [x] **T11** Rate limits — a global one, a stricter one on authentication and on the patient's one-time codes, per IP and per account — with the limits tested
- [x] **T12** Request and upload size limits, and a review of the upload and scanning path against a hostile file
- [x] **T13** A CORS and cookie posture review, written down, including what changes when refresh tokens move to cookies

**The application was configured in two places, and only one was tested.** The
headers, the body limits and the CORS rules lived in `main.ts`, which no test
suite runs — every suite built its own application without them. They now live
in `configureApp`, called by `main.ts` and by the test harness, so what the
suites drive is what is deployed. That was the finding of the phase: not a
missing header, but a missing guarantee that any of them were there.

**One definition of the policy, used three times.** The API's own headers,
both apps' dev servers and the static server in front of the built apps all
read `packages/shared/src/security-headers.ts`. Development relaxes exactly two
directives — the ones Vite needs — and nothing else, so a framing or referrer
mistake shows up on a laptop rather than in production.

**A content security policy that breaks a screen breaks it silently**, which
is why the clinical browser suite now asserts the headers arrive and then
drives a screen under them, watching for a refusal in the console.

**The limits that were already right were left alone.** Sign-in allows sixty
attempts a minute per address, and the plan's "stricter on authentication"
would have been wrong: a hospital is behind one NAT and a shift changes
together, so a tight per-address limit locks out a ward rather than an
attacker. What protects an account is the exponential lockout, which already
exists. The tests now assert the limits that are actually there, and that they
are counted per route.

**One thing the upload review changed.** Object storage answers downloads
itself, so this API's `nosniff` is not on that response — a presigned URL now
pins `ResponseContentType` to the type the record holds, so a stored file
cannot be served as anything else. What the review does not claim is also
written down: a signature scanner does not stop a targeted document exploit,
and the answer to that is that nothing renders these files on the app's own
origin.

### Phase 4 — Containers and infrastructure

- [x] **T14** Multi-stage Dockerfiles for the API, the worker, the clinical app and the portal: non-root, minimal, healthchecked, reproducible
- [x] **T15** `docker-compose.prod.yml` running the whole stack from those images, with migrations as a job rather than on boot
- [x] **T16** Terraform for `ap-south-1` covering the resources in the definition of done, formatted and validated in CI (V1)
- [x] **T17** A deploy workflow that builds, scans, pushes and would deploy — gated on approval, and inert without credentials

**Running the stack found four things, which is what it is for.** In order:

The API refused to start, twice, and both refusals were right: plain HTTP to
storage and static storage credentials. The rule they came from was about a
deployment reaching storage across the internet, and it was written as
"production", which caught a container talking to a container on its own
machine. It is now written as what it means — refused unless the endpoint is
loopback or a bare hostname on a private network — and there are tests for both
sides of that line. The alternative was running the local stack with the
refusals off, which is how a production check quietly becomes decorative.

The worker refused to start without `CORS_ORIGINS`, which it never uses because
it answers no HTTP request. The compose file was wrong rather than the rule:
Terraform already gives both processes the same configuration, and a local stack
that diverges from that proves less than it appears to. One line, not a new
exception.

The bucket had to be created by an S3 client rather than by the application,
because the API's own bootstrap command refuses to run in production — a
production bucket is not something an application should be able to create.
That refusal is also right, and running it into the ground would have been the
easy way to make the stack start.

And the browser suite broke: the worker's new probe port defaults to 3100, which
is the port the browser tests give the API, so the worker bound it first and
answered every POST with a 405. The test harness now names the worker's port.

**The images are one per job, not one per process.** The API and the worker
share an image and differ by their command; both apps share a Dockerfile and
differ by a build argument. The nginx images get their security headers
**generated** from the same module the dev server uses, so what production sends
is what the browser suites ran against — 520 MB for the API, 75 MB for each app,
all non-root with a read-only root filesystem.

**Migrations are a job that is waited for, and `/version` says what is running.**
Both are there because of the same failure: a deploy where half the tasks serve
against a schema they do not expect, and nobody can say which commit is which.

**The infrastructure is written, formatted and validated — and applied to
nothing.** `terraform validate` passes (run through the Terraform container,
since Terraform is not installed here), CI runs the same three commands with
`-backend=false`, and the first real apply is a task in SP8 rather than a claim
in this plan. Two properties the definitions enforce rather than mention:
nothing holding patient data has a route from the internet, and no secret
passes through Terraform — the database's master password is generated by AWS
into Secrets Manager, and there is no `secret_version` resource anywhere.

### Phase 5 — Backups and restore

- [x] **T18** The backup position: what is backed up, how often, where it is kept, how long, and who can read it
- [x] **T19** A restore drill script: dump, restore into a scratch database, boot the application against it, prove the record reads correctly (DF7)
- [x] **T20** The drill in CI on synthetic data, with the measured RPO and RTO written into the runbook
- [x] **T21** The migration position: how a bad migration is caught before production, and what is done when one reaches it

**The drill asks the restored copy five questions**, and the one that matters
most is not "is the record there": it is whether row-level security is still
enabled and forced. A dump restored carelessly loses policies, and a restored
database with the rows intact and the policies gone would serve every
hospital's record to every other — while looking, from every screen, exactly
right.

**"The dump restores" and "the system runs on it" are different claims.** The
script proves the first; the test proves the second by booting the application
against the restored copy and signing a member of staff in to read a patient
through the API. The second is the one people discover to be false at three in
the morning.

**It runs where a developer is, not only where CI is.** Neither `pg_dump` nor
`pg_restore` is installed on this machine, so the drill uses the same Postgres
image the database runs from — and chooses between the two by comparing the
client's major version with the server's, because a client older than its
server refuses to dump at all. A drill only CI can run is a drill nobody runs.

**The timings are published and hedged.** 0.45 MB dumps, restores and verifies
in 5.6 seconds here, and that number says something about the procedure and
nothing about production. The runbook says so in those words: the recovery time
to promise a hospital is the one measured against a production-sized copy, and
that measurement waits for the first staging environment.

**Migrations are append-only, and CI now enforces it.** A pull request that
edits or deletes a file under `apps/api/drizzle/*.sql` fails, because an edited
migration means the database somebody already migrated and the repository
disagree with nothing to say so. The runbook also writes down the shape that
makes a rollback possible at all: anything destructive happens in two deploys —
stop using it, then drop it — never one.

### Phase 6 — Security review

- [x] **T22** A threat model per trust boundary — browser to API, API to database, worker to queue, storage, the patient portal, the platform role — with what stops each threat
- [x] **T23** A checklist run against the code: authorisation paths, error messages, token handling, file handling, injection surfaces; findings recorded and each fixed or accepted in writing (W1)
- [x] **T24** Dependency, secret and container scanning in CI, failing the build on high severity, with an accepted-risk file (DF8)
- [x] **T25** A pen-test scope document: what is in scope, what an external tester is given, and what "pass" means

**The worst finding was one this plan predicted and still missed.** Phase 3 said
a content security policy breaks a screen silently; Phase 6 then found that ours
refused every document — an `img`, an `iframe` and the presigned upload, all
three — because it named only the app's own origin. Found by loading the app in
a browser and trying it, not by reading the policy. The fix names the storage
origin as configuration substituted at container start, and three tests now
fail if it is dropped again, including one that watches the browser console.

**Exposure was established, not assumed, and the fix applied anyway.** The
`drizzle-orm` advisory — SQL injection through unescaped identifiers — reaches
applications that pass untrusted input to `sql.identifier()`. The one call here
takes a key of a seven-entry constant chosen by a Zod enum, so nothing was
exposed; it was upgraded regardless, because "this call site is safe" is an
argument that has to be made again every time somebody adds one. The same for
`multer` and `lodash`: no exposure today, overridden anyway, because a
`FileInterceptor` added next year would reintroduce one silently.

**The ORM upgrade broke two things, and the suite caught both.** Drizzle 0.45
wraps every failed query in its own error and moves the driver's underneath, so
a check reading only the top-level message stopped matching: a correction
request naming a hospital the patient is not registered at turned from a 400
into a 500. One helper now walks the whole chain, with unit tests that need no
database — and the lesson is written into the review: an upgrade is not
verified until the integration suite has run against it.

**The gate is on what ships, and the rest is written down.** Production
dependencies fail the build on a high or critical advisory; development and
build tooling is reported and reviewed in `accepted-risks.md` with dates,
because a build that fails daily on a vulnerability in a test runner teaches
everybody to ignore the scanner. Secrets are scanned in the working tree **and
in history** — a secret removed in a later commit is still in every clone.

**The checklist records what it found and what it did not.** "Checked, nothing
found" is written down deliberately: a list that only holds problems cannot be
told apart from a list nobody ran. And what the review could not cover — the
hospital's network, the cryptographic primitives, capacity, the infrastructure
as deployed — is stated rather than left to be assumed.

### Phase 7 — Runbooks and the compliance position

- [x] **T26** `docs/runbooks/`: breach notification (with the DPDP timelines), restore from backup, key rotation, incident response, and the on-call basics (DF9)
- [x] **T27** The DPDP Act self-assessment: each obligation mapped to where the system satisfies it, and the gaps listed with owners (DF10)
- [x] **T28** The EHR Standards 2016 self-assessment, in the same shape
- [x] **T29** The data retention and erasure position, tying together SP5's erasure work, the audit trail's retention and what the law requires kept
- [x] **T30** A walk-through of each runbook, and the corrections that walk-through produces

**The self-assessments say what is not done, and who has to do it.** Every gap
carries an owner and a date, and the summary of the DPDP page is that none of
its nine gaps is a code gap: the engineering half of the Act is in good order
and the legal half has not started. The EHR Standards page divides the same way
— security, audit, consent and clinical content are in place and tested;
SNOMED CT, ABHA and FHIR over the wire are mostly not built, which is what SP8
is for.

**Two things this phase refused to invent.** The breach timeline is written as
the working assumption with counsel named as the person who confirms it, rather
than stated as fact. And the retention periods are left as "unconfirmed" in the
table rather than filled in with plausible numbers — a hospital would believe
them, and nobody here is qualified to have chosen them.

**The walk-through found a query that would have failed** at exactly the wrong
moment: the breach runbook's audit-trail query named `actor_kind` for a column
called `actor_type`. Every query in that runbook has now been run against a
real database. The part of a walk-through that can be automated now is —
`documentation.spec.ts` checks that every link in the documentation resolves
and that every `pnpm` command a page tells somebody to type is one a package
defines. It was tested by breaking a link deliberately and watching it fail.

**On call is described as it actually is:** one developer, no rota, which is
fine for synthetic data and not fine for a real patient record. The runbook says
so, and says what has to exist first — two people, a written rota, and one
rehearsal of a page at an inconvenient hour.

### Phase 8 — Verification

- [ ] **T31** The production-like smoke in CI: build the images, bring the stack up, migrate, run the smoke scripts against it
- [ ] **T32** The acceptance scenario below
- [ ] **T33** A README that gets a new engineer from a clone to a running stack, and points at everything above

---

## The acceptance scenario

A new engineer joins on a Monday, with the repository and nothing else.

1. They follow the README and have the whole stack running locally from the production images, with synthetic data, inside an hour.
2. They break something deliberately — stop Redis — and `/ready` fails while `/health` still answers, and the page tells them which dependency is down.
3. They run the restore drill: yesterday's synthetic dump restores into a scratch database, the application boots against it, and Lakshmi's record reads correctly.
4. They add a dependency with a known high-severity advisory; CI fails and names it.
5. They write a log line containing a patient's name in a branch; the scrubber test fails.
6. A hospital asks what happens if data leaks. They open `docs/runbooks/breach-notification.md` and can say who is told, within what time, and by whom.
7. A hospital's counsel asks how the DPDP Act's obligations are met. They open the self-assessment and can point at the code for each — and at an honest list of what is not done yet.
8. Someone with an AWS account runs `terraform plan`; it plans cleanly, and nothing has been created until they say so.

---

## Risks specific to SP7

| Risk                                                                            | Response                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Infrastructure written but never applied drifts from what the cloud accepts     | Terraform is formatted, validated and planned in CI; the first real apply is expected to find something, and is scheduled as a task in SP8 rather than assumed away |
| Logs quietly become a second copy of the record                                 | The scrubber sits between the application and every sink, and a test asserts a name, an MRN, a phone number and clinical text cannot reach one (DF4)              |
| A compliance document that claims more than the code does                       | Every line of the self-assessment points at code, a test or an open item; gaps are listed rather than smoothed over (DF10)                                        |
| Security work that is all scanners and no thinking                              | The threat model and the checklist are tasks of their own, and their findings are recorded whether or not they are fixed (W1)                                     |
| Hardening that breaks the apps quietly — a content security policy that kills a screen | The browser suites from SP5 and SP6 run against the hardened stack, which is what a content security policy mistake fails against                                 |
| Runbooks written once and never read                                            | T30 walks through each one and corrects it; a runbook nobody has followed is a draft                                                                              |

---

## Open items outside the code

- **Counsel**: terms, privacy policy, the data-processing agreement each hospital signs, and the DPDP registration and consent-manager obligations.
- **Licensing**: NAMASTE and ICD-11 redistribution inside a commercial product — still the open question from `planning.md` §15.
- **A decision on medical device classification** (CDSCO), taken with advice, before any feature drifts toward clinical decision support.
- **Professional indemnity and cyber insurance**, before the first real record.
- **An AWS account and a budget**, before anything is applied.
- **An external penetration test**, scoped by T25, before a pilot goes live with real patients.

---

## Estimate

`planning.md` §14 gives stage 7 **6–10 weeks** for one developer: configuration and observability about 1.5 weeks, hardening about 1 week, containers and infrastructure about 2 weeks, backups and the restore drill about 1 week, the security review about 1.5 weeks, and the runbooks and compliance documents about 2 weeks. The documents are the part most likely to be underestimated, because they are the part that cannot be half-written.
