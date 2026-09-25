-- SP7 Phase 2: how far the schema has been migrated (sp7-plan.md, T8, DF6).
--
-- The readiness probe has to know whether the database is at the schema this
-- build expects: a process serving against an older schema is the quiet half
-- of a bad deploy, where most routes work and the ones touching the new column
-- fail one at a time.
--
-- It cannot read the migration history to find out. SP1 deliberately kept that
-- from the application role, and `rls.e2e-spec.ts` asserts it — an application
-- that can read `drizzle.__drizzle_migrations` is one that can be asked what
-- the schema looked like before, which is nobody's business at runtime.
--
-- So it learns a number instead of a history: one function, owned by the
-- schema owner, returning how many migrations have been applied and nothing
-- else. `search_path` is pinned because a SECURITY DEFINER function without
-- one is a way to run the owner's privileges against somebody else's table.

CREATE OR REPLACE FUNCTION app.schema_version() RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = drizzle, pg_temp
  AS $$
    SELECT count(*)::int FROM drizzle.__drizzle_migrations
  $$;

REVOKE ALL ON FUNCTION app.schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.schema_version() TO health24_app;
