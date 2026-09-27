# Runbook — migrations

How a schema change reaches production, how a bad one is caught first, and what
to do when one gets through anyway (sp7-plan.md, T21).

## The rule

**A migration that has been applied anywhere is history.** It is never edited,
never renumbered and never deleted. If it was wrong, the fix is another
migration.

This is not a preference. Drizzle records a hash of every migration it applies;
editing a file makes the database and the repository disagree, and nothing will
ever tell you so — the next environment gets the corrected version, the existing
one keeps the mistake, and the two drift apart silently. CI enforces it: a pull
request that changes or removes a file under `apps/api/drizzle/*.sql` fails.

It has already bitten this project once — SP6's invoice migrations were
regenerated, and that was only safe because nothing had applied them yet.

## How a change is made

```bash
# A schema change, generated from the Drizzle schema
pnpm --filter @health24/api exec drizzle-kit generate --name=what_it_does

# Something Drizzle cannot express — a policy, a trigger, a function
pnpm --filter @health24/api exec drizzle-kit generate --custom --name=what_it_does

pnpm --filter @health24/api db:migrate      # apply it locally
pnpm --filter @health24/api test            # every suite, against the result
```

Two things worth saying about writing them:

- **Row-level security is part of the migration, not of the application.** A new
  table with no policy is a table that leaks every hospital's rows to every
  other, and `test/rls-coverage.e2e-spec.ts` fails for exactly that.
- **Immutability is part of it too.** A clinical table gets its guard trigger in
  the same migration that creates it, or it never gets one.

## How a bad migration is caught before production

Four gates, in the order they fire:

1. **Every migration is applied to an empty database on every CI run.** The
   integration suite's global setup drops and recreates the test database, so a
   migration that cannot be applied from scratch fails immediately — which is
   the failure mode a long-lived development database hides.
2. **676 tests then run against the result**, including the row-level security
   sweep, the authorisation matrix and the acceptance scenarios. A migration that
   breaks a policy or a guard trigger fails a test that names it.
3. **The restore drill** dumps and restores the migrated database and checks that
   row-level security survived (`restore.md`).
4. **The readiness probe.** After deploying, a task whose database has fewer
   migrations than the build expects reports itself not ready, so the load
   balancer keeps traffic away rather than letting half the routes work
   (migration 0066, `docs/observability.md`).

And the deploy itself: migrations run as **one job that is waited for**, before
any task is replaced. Two tasks starting together would both try to migrate.

## When one reaches production anyway

### It failed halfway

Postgres runs each migration in a transaction, so a failed statement rolls its
own migration back. The deploy stops at that point: earlier migrations are
applied, this one is not, and no task has been replaced yet — the old code is
still serving against the schema it expects.

1. Read the migration job's log (`/health24/production/migrate`).
2. Fix it in a **new** migration, or correct the not-yet-applied file if it never
   reached any environment.
3. Deploy again. Nothing needs undoing, because nothing was half-applied.

### It succeeded, and it was wrong

This is the dangerous case, because the deploy will have carried on.

1. **Is the old code still able to run?** An additive change — a new column, a
   new table, a new index — usually is, so rolling the application back is
   enough while the schema stays as it is.
2. **A destructive change is not rollable.** A dropped column cannot be brought
   back by deploying last week's image; the data is gone. That is what
   `restore.md` is for, and why a migration that drops anything is worth a second
   reader before it merges.
3. **Write the correcting migration**, deploy it, and leave both in history. The
   repository should read as what actually happened.

### The shape that avoids all of this

A change that has to remove something is done in two deploys, never one:

1. Deploy code that no longer uses the column, keeping the column.
2. Later, once nothing reads it, deploy the migration that drops it.

Slower, and it means a rollback is always possible. For a clinical record, that
is the right trade.

## What is never done

- **Editing an applied migration.** Covered above, and refused by CI.
- **Running a migration from a laptop against production.** The owner's
  credentials exist only in the migration task; a developer never has them
  (`docs/secrets.md`).
- **`drizzle-kit push`.** It diffs the schema against a live database and applies
  whatever it decides, with no file and no history. There is no version of that
  which belongs anywhere near a patient record.
