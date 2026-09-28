# Health24

A unified patient record for Indian hospitals, where a traditional-medicine
diagnosis is recorded in its own vocabulary **and** in ICD-11 at the same time —
so an Ayurvedic clinic and an allopathic hospital can read the same patient's
record without either of them having to pretend to be the other.

The patient owns access to it: they sign in from their phone, see who read their
record, share it with a hospital and stop sharing it again.

**Status: not in production, and holding no real patient record.** Six
sub-projects are built and tested; the seventh — production readiness and
compliance — is complete in code and has open items that only counsel and a
pilot hospital can close (`sp7-plan.md`, `docs/compliance/`).

---

## Getting it running

You need **Docker**, **Node 22** and **pnpm 10**. Everything else comes from the
repository.

```bash
git clone <this repository> health24 && cd health24
cp .env.example .env
pnpm install

docker compose up -d          # postgres, redis, object storage, the virus scanner
pnpm db:wait                  # the first start takes a minute
pnpm db:migrate               # apply every migration
pnpm db:bootstrap             # create the unprivileged role the app connects as
pnpm db:seed                  # two hospitals, some staff, synthetic patients
pnpm terminology:load-demo    # synthetic NAMASTE and ICD-11, safe to code against

pnpm --filter @health24/api dev        # the API, on 3000
pnpm --filter @health24/clinical dev   # the clinical app, on 5173
pnpm --filter @health24/portal dev     # the patient portal, on 5174
```

Sign in at <http://localhost:5173> with a seeded account. `pnpm db:seed` prints
the addresses and the shared password **when it seeds**; on a database that is
already seeded it says so and prints nothing, and both are in
`apps/api/src/db/seed.ts`. Every account has a second factor; the first sign-in
enrols it, and `node apps/api/scripts/mfa-code.mjs` prints a code if you would
rather not use a phone.

**The data is synthetic, always.** There is no path from a real record to a
developer's machine, and there is not meant to be.

### The same thing, from the production images

```bash
cp .env.prod-local.example .env.prod-local   # then fill in the two keys it names
docker compose -f docker-compose.prod.yml up --build
node scripts/smoke-prod-stack.mjs
```

That is the images that would be deployed, with `NODE_ENV=production` and every
production refusal in force — the clinical app on 8081, the portal on 8082, the
API on 3001. It is the cheapest place to find a configuration mistake, and it
has already found several (`docs/deployment.md`).

## What is here

```
apps/api        the API and the worker: NestJS, Postgres with row-level security
apps/clinical   what a hospital uses — encounters, orders, wards, billing, reports
apps/portal     what a patient uses, on a phone
packages/shared the contracts both sides agree on: schemas, permissions, enums
infra/terraform AWS Mumbai, written and validated, applied to nothing yet
docs/           how it is run, secured and kept — start with the table below
```

## The idea, in four decisions

**The database enforces tenancy and consent, not the application.** Every query
runs as an unprivileged role under row-level security; a query with the wrong
context returns nothing, whatever the code asked for. A sweep fails if any table
is added without it.

**Clinical rows are never edited or deleted.** A correction is a new version and
the old one stays readable. Guard triggers in the database refuse anything else,
so this holds even if the application is wrong.

**Every diagnosis carries both codes.** The clinician chooses a NAMASTE term;
the system attaches the ICD-11 code its mapping gives, with the equivalence and
the version it came from, kept as a snapshot so a later mapping change cannot
rewrite history.

**Every read is audited, and the patient can see it.** Including access taken in
an emergency, which requires a reason, notifies the patient, and is reviewed.

## Running the tests

```bash
pnpm test                       # every package's unit tests
pnpm --filter @health24/api test  # 693 integration tests against a real Postgres
pnpm test:e2e                   # 29 browser tests: the portal on a phone, the clinical app on a desktop
pnpm --filter @health24/api db:restore-drill   # dump, restore, and prove the record reads
pnpm lint && pnpm typecheck
```

The integration suite drops and recreates its own database, so it needs Docker
running and nothing else. It is slow on purpose: it runs the real application
against a real database, because most of what this system promises is
relational.

## The documentation

| If you want to | Read |
| --- | --- |
| Set it up, or understand a variable | [docs/configuration.md](docs/configuration.md) |
| Know where secrets live | [docs/secrets.md](docs/secrets.md) |
| Understand the logs, probes and metrics | [docs/observability.md](docs/observability.md) |
| Know what a browser is told, and what is refused | [docs/hardening.md](docs/hardening.md) |
| Deploy it, or read the infrastructure | [docs/deployment.md](docs/deployment.md) |
| Know how far ABDM has got, and what is not certified | [docs/abdm.md](docs/abdm.md) |
| Handle an incident, a breach, a restore, a key rotation | [docs/runbooks/](docs/runbooks/) |
| See the security position, honestly | [docs/compliance/threat-model.md](docs/compliance/threat-model.md), [security-review.md](docs/compliance/security-review.md) |
| Answer a hospital's counsel | [docs/compliance/dpdp-self-assessment.md](docs/compliance/dpdp-self-assessment.md), [ehr-standards-self-assessment.md](docs/compliance/ehr-standards-self-assessment.md) |
| Know what is kept and for how long | [docs/compliance/retention-and-erasure.md](docs/compliance/retention-and-erasure.md) |
| Understand why any of it is the way it is | `planning.md`, then `sp1-plan.md` … `sp7-plan.md` |

Each `spN-plan.md` records the decisions taken before that sub-project was
built, and — under each phase — what it turned out to be, including what went
wrong. They are the honest history, and they are worth more than this page.

## What is not built

- **ABDM**: ABHA linking, the HIP and HIU adapters, and a `/fhir/R4` read
  surface. That is SP8, and `docs/compliance/ehr-standards-self-assessment.md`
  says what it takes.
- **SNOMED CT**, which the EHR Standards name and which needs a licence, a
  mapping strategy and a clinical reviewer.
- **A coded prescription vocabulary** for Ayurvedic formulations. Nobody has one;
  `planning.md` §15 asks the question.
- **The legal half of the DPDP Act**: notice text, processing agreements,
  retention periods, a published grievance contact. Listed with owners in
  `docs/compliance/dpdp-self-assessment.md`.
- **An external penetration test**, scoped in
  [docs/compliance/pen-test-scope.md](docs/compliance/pen-test-scope.md) and due
  before the first real patient record.

## A note on how this is built

Everything that matters is enforced by something that cannot be forgotten: the
database, a guard trigger, a test that sweeps every route or every table, a
check in CI. Where that was not possible, it is written down with an owner and a
date rather than left as an intention. The plans record what went wrong as well
as what worked, because the second is only believable beside the first.
