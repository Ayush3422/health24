# SP1 — Foundation: Implementation Plan

**Status:** In progress
**Scope:** Tenancy, identity & auth, patient registry, audit skeleton. No clinical data.
**Design reference:** `planning.md` §5, §6.1, §6.2, §8 · `features.md` SP1

---

## Definition of done

SP1 is complete when all of the following are true, demonstrated by passing tests:

1. A platform admin can onboard a hospital.
2. A hospital admin can invite staff and assign roles.
3. Staff sign in with password + TOTP and receive a scoped session.
4. Front-desk can register a patient and receive an auto-generated MRN.
5. Searching for a patient returns only patients of the caller's own hospital, enforced by the database.
6. A patient already registered elsewhere is surfaced as a match candidate, never auto-merged below the confidence threshold.
7. Every read and write of patient data appears in an append-only audit log.
8. The authorisation test suite proves wrong-tenant and wrong-role access is denied on every endpoint.

---

## Architecture decisions for SP1

| Decision | Choice | Rationale |
|---|---|---|
| Repo layout | pnpm workspace monorepo | Shared types between API and clients without publishing |
| API framework | NestJS | Module boundaries enforced structurally; matters for a solo build |
| ORM | Drizzle | Typed SQL, real migrations, no hidden query generation |
| Tenant isolation | Postgres RLS via session variable | DB enforces it; an application bug cannot leak across tenants |
| Password hashing | argon2id | Current best practice |
| Sessions | Opaque refresh token in DB + short-lived access JWT | Server-side revocation is required for clinical systems |
| IDs | UUIDv7 | Time-sortable, no enumeration, safe in URLs |
| Validation | Zod, shared between API and clients | One schema, two consumers |
| Tests | Vitest + Testcontainers (real Postgres) | Correctness here is relational; mocked DBs prove nothing |

---

## Task breakdown

Tasks are ordered. Each is independently verifiable.

### Phase 1 — Skeleton

- [x] **T1** Workspace scaffold: pnpm workspace, root tsconfig, eslint, prettier, .gitignore, .env.example
- [x] **T2** `docker-compose.yml` — Postgres 16 + Redis, with healthchecks
- [x] **T3** `packages/shared` — Zod schemas, enums, shared types
- [x] **T4** `apps/api` NestJS bootstrap: config module, health endpoint, structured logging with PHI scrubbing
- [x] **T5** Drizzle setup: connection, migration runner, npm scripts

### Phase 2 — Data layer

- [x] **T6** Schema: `hospital`, `staff_user`, `role` enum, `session`
- [x] **T7** Schema: `patient`, `patient_hospital_link`, `patient_account`
- [x] **T8** Schema: `patient_merge_candidate`, `patient_merge_log`
- [x] **T9** Schema: `access_log` — append-only, no UPDATE/DELETE grant
- [x] **T10** RLS policies on every tenant-scoped table, driven by `app.current_hospital_id`
- [x] **T11** Seed script: one platform admin, two hospitals (one Ayush, one allopathic), staff in each

### Phase 3 — Identity & access

- [x] **T12** Password service: argon2id hash/verify, password policy
- [x] **T13** TOTP service: enrolment, QR provisioning URI, verification, recovery codes
- [x] **T14** Session service: issue, refresh, revoke, list active sessions
- [x] **T15** `AuthGuard` — validates access token, loads actor
- [x] **T16** Tenant context — implemented as `DatabaseService.asTenant()` rather than an interceptor, so each call site names the hospital it acts for instead of relying on ambient request state
- [x] **T17** `RolesGuard` + `@Roles()` decorator, permission matrix
- [x] **T18** Auditing is explicit per service rather than a blanket interceptor, so each entry carries the patient it concerns — an interceptor cannot know that. Verified in the database: patient reads, searches, creates, updates, merges, reverts, logins, failures and authorisation denials all produce rows
- [x] **T19** Auth endpoints: login, verify-TOTP, refresh, logout, logout-all

### Phase 4 — Tenancy & staff

- [x] **T20** Hospital module: CRUD for platform admin, read-own for hospital admin
- [x] **T21** Staff module: invite, accept invite, list, update role, deactivate, reinstate

### Phase 5 — Patient registry

- [x] **T22** MRN generator: per-hospital, configurable prefix, collision-safe
- [x] **T23** Patient registration endpoint
- [x] **T24** Patient search: name, phone, MRN, ABHA — tenant-scoped
- [x] **T25** Identity matching service: deterministic ABHA match; probabilistic score on phone + DOB + name similarity
- [x] **T26** Global lookup endpoint returning match candidates with scores
- [x] **T27** Merge queue: list candidates, approve, reject
- [x] **T28** Merge execution: reversible, fully logged
- [x] **T29** Patient demographic update with change history

### Phase 6 — Verification

- [x] **T30** Unit tests: matching algorithm, MRN generation, password policy, TOTP
- [ ] **T31** Integration tests: every endpoint against real Postgres
- [ ] **T32** Authorisation suite: wrong tenant, wrong role, revoked session — denied on every endpoint
- [ ] **T33** RLS test: raw query as tenant A cannot see tenant B's rows
- [ ] **T34** Audit test: every PHI-touching endpoint produces a log row
- [ ] **T35** CI: GitHub Actions running lint, typecheck, migrate, test

### Phase 7 — Clinical app shell

- [ ] **T36** `apps/clinical` Vite + React + TanStack Router/Query scaffold
- [ ] **T37** Login screen with TOTP step
- [ ] **T38** App shell: nav, hospital context, sign-out
- [ ] **T39** Patient register screen
- [ ] **T40** Patient search + detail screens
- [ ] **T41** Merge review queue screen

---

## Out of scope for SP1

Encounters, diagnoses, prescriptions, documents, consent artefacts, the patient portal, ABHA verification against the real ABDM sandbox. `patient.abha_number` is captured and stored in SP1 but not verified.

---

## Test strategy for SP1

- Every test runs against a real Postgres in Testcontainers. No mocked database.
- The authorisation suite is generated from a table of `(endpoint, allowed roles)` so a new endpoint without an entry fails the build.
- Identity matching gets property-based tests — it is the function whose failure is worst.
