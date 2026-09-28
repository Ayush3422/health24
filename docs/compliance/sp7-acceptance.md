# SP7 acceptance — walked

The eight steps of the acceptance scenario in `sp7-plan.md`, walked on
**2026-09-28**, with what actually happened (T32).

Two of them did not happen the way the plan imagined. Both are recorded as they
went rather than as they were written, and both produced a change.

---

## 1. A new engineer, from a clone to a running stack

**Done.** The README's steps were followed as written:
`docker compose up -d`, `db:wait`, `db:migrate`, `db:bootstrap`, `db:seed`,
`terminology:load-demo`. Every command exists and every one succeeded, well
inside the hour the plan allows.

**One correction it produced.** The README said `pnpm db:seed` prints the
accounts and the shared password. On a database that is already seeded it says
"Hospitals already seeded" and prints nothing — which is exactly the state a
returning engineer is in. The README now says both, and names the file the
password is in.

The production-image route was walked too:
`docker compose -f docker-compose.prod.yml up --build` followed by
`node scripts/smoke-prod-stack.mjs` — **26 of 26 checks passed**, including that
both apps' content security policy names the storage origin, which is the
Phase 6 fix arriving in a built image rather than only in a test.

## 2. Stop Redis: readiness fails, liveness does not

**Done, exactly as designed.** With `redis` stopped:

```
/health  200  {"status":"ok","uptimeSeconds":41}
/ready   503  {"ready":false,"checks":{
                 "database":{"state":"up","ms":5},
                 "migrations":{"state":"up","ms":5},
                 "redis":{"state":"down","detail":"did not answer within 2000ms","ms":2001},
                 "storage":{"state":"up","ms":6}}}
```

The process stays alive — restarting it would not have fixed Redis — and the
answer names which dependency is down rather than saying "unhealthy". Starting
Redis again returned `/ready` to 200 within eight seconds.

## 3. The restore drill

**Done.** `pnpm --filter @health24/api db:restore-drill` dumped the database,
restored it into a scratch copy and asked it five questions — schema version,
the record is there, row-level security survived, the application sees nothing
without a context, and the right rows with one. All five passed; 0.45 MB in 5.6
seconds. `test/restore-drill.e2e-spec.ts` additionally boots the application
against the restored copy and signs a member of staff in to read a patient
through the API.

## 4. A dependency with a known advisory fails CI

**Done, by actually doing it.** `lodash@4.17.21` was added as a direct
production dependency of the API and the override removed:

```
$ pnpm audit --prod --audit-level high
… lodash  Code Injection via `_.template`  GHSA-r5fr-rjxr-66jc
Severity: 1 low | 10 moderate | 1 high
$ echo $?
1
```

Exit code 1 is what fails the build. Removing it again returned the audit to
exit 0 with no high or critical finding. The manifest and the lockfile were
restored.

## 5. A log line containing a patient's name

**This is the one that went differently, and it found a real gap.**

The plan expected: write a leaking log line, watch the scrubber test fail. A
line was planted in `PatientsService.register`:

```ts
this.logger.log(`Registering ${input.name} on ${String(input.phone)}`);
```

**First run: the test passed.** Not because the line was scrubbed — because it
never reached the log at all. The test harness built the application without
installing the pino logger that `main.ts` installs, so a service writing through
Nest's own `Logger` went to stdout in tests and through the scrubber only in
production. The test that exists to prove no patient reaches a log line was not
looking at the lines a service writes.

**Fixed**: the harness now installs the same logger `main.ts` does. With the
line still planted, the test fails as it should:

```
× the log › never writes the patient's name, phone or MRN — however they got there
  → expected … not to contain 'Lakshmi Logtest'
     "context":"PatientsService","msg":"Registering Lakshmi Logtest on [redacted]"
```

Two things are visible in that message and both matter. The **phone was
redacted** — the scrubber recognised it by shape. The **name was not**, because
a name is not detectable by shape; it looks like any other words. So the
division of labour is: the scrubber catches keys and patterns, and the **test**
catches a name somebody interpolated into a message. That is now written into
`docs/observability.md` rather than left as an assumption.

The planted line was removed and the suite is green.

## 6. A hospital asks what happens if data leaks

**Done.** [`docs/runbooks/breach-notification.md`](../runbooks/breach-notification.md)
answers who is told (the Data Protection Board and **every affected patient** —
the Act has no severity threshold), within what time (72 hours to the Board,
without delay to patients, as the working assumption counsel confirms), and by
whom. Its audit-trail queries were run against a real database during the
Phase 7 walk-through, which is how a wrong column name was found.

## 7. A hospital's counsel asks about the DPDP Act

**Done, with a caveat that is the point of the page.**
[`docs/compliance/dpdp-self-assessment.md`](dpdp-self-assessment.md) maps each
obligation to where it is satisfied, and ends with nine gaps, each with an owner
and a date. Its own summary is the honest answer to counsel: **none of the nine
is a code gap.** The engineering half of the Act is in place; the legal half —
notice text, processing agreements, retention periods, a published grievance
contact — has not started.

## 8. `terraform plan` against a real account

**Not done, and it cannot be from here.** There is no AWS account (Decision V1),
so what was verified is everything short of it: `terraform fmt -check`,
`terraform init -backend=false` and `terraform validate` all pass, run through
the Terraform container because Terraform is not installed on this machine, and
CI runs the same three on every push.

The first real `terraform plan` will find something. That is a task in SP8, and
writing it down here is the alternative to pretending this step passed.

---

## What the walk changed

| Step | Change |
| --- | --- |
| 1 | The README now describes what `db:seed` does on an already-seeded database |
| 5 | The test harness installs the scrubbing logger, so the logging test covers what services write; `docs/observability.md` states what the scrubber cannot do |
| 8 | Recorded as not done rather than marked complete |

Seven of eight steps pass. The eighth is honest about why it cannot.
