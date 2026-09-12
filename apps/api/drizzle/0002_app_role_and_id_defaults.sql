-- SP1 correction: make row-level security actually bind, and give every table
-- a database-level primary key default.
--
-- Two defects found by testing migration 0001 against real data:
--
--   1. RLS was not enforced, because the application connected as a superuser.
--      Superusers bypass RLS unconditionally, and FORCE ROW LEVEL SECURITY
--      binds only table owners — not superusers. Tenant isolation was
--      therefore decorative. The fix is a dedicated, unprivileged application
--      role; the owner role remains for migrations and seeding.
--
--   2. Primary keys had no database default. Drizzle's $defaultFn generates
--      UUIDv7 in the application, which is fine for application writes and
--      useless for everything else. A NOT NULL id with no default means any
--      other writer — a psql session, a future job, a restore script — fails
--      or, worse, is written around. gen_random_uuid() is the floor;
--      application writes still supply a time-sortable v7.

--------------------------------------------------------------------------------
-- 1. Primary key defaults
--------------------------------------------------------------------------------

ALTER TABLE "hospital"                   ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "staff_user"                 ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "session"                    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "patient"                    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "patient_account"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "patient_merge_candidate"    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "patient_merge_log"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "patient_demographic_change" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "access_log"                 ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

--------------------------------------------------------------------------------
-- 2. Hospital visibility
--------------------------------------------------------------------------------

-- A hospital admin should not be able to enumerate every other facility on the
-- platform. Platform administration runs in system context.
ALTER TABLE "hospital" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hospital" FORCE ROW LEVEL SECURITY;
CREATE POLICY hospital_tenant_isolation ON "hospital"
  USING (app.is_system() OR "id" = app.current_hospital_id())
  WITH CHECK (app.is_system());

--------------------------------------------------------------------------------
-- 3. The application role
--------------------------------------------------------------------------------

-- `health24_app` is a privilege group, not a login. Deployments create a login
-- role and grant it membership; the local bootstrap script does the same for
-- development. Keeping the password out of migrations means this file is safe
-- to run anywhere.
--
-- Critically, this role is NOT a superuser and NOT the table owner, so RLS
-- binds to it. That is the entire point.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'health24_app') THEN
    CREATE ROLE health24_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO health24_app;
GRANT USAGE ON SCHEMA app TO health24_app;

-- Every context helper must be callable, or no policy can be evaluated.
GRANT EXECUTE ON FUNCTION app.current_hospital_id() TO health24_app;
GRANT EXECUTE ON FUNCTION app.is_system() TO health24_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO health24_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO health24_app;

-- The audit trail is append-only for the application. The triggers from
-- migration 0001 are the backstop; this is the first line, and it means an
-- attempt does not even reach the trigger.
REVOKE UPDATE, DELETE ON "access_log" FROM health24_app;
REVOKE DELETE ON "patient_merge_log" FROM health24_app;

-- The schema migrations table belongs to the owner alone. The application has
-- no business reading or writing its own migration history.
REVOKE ALL ON SCHEMA drizzle FROM health24_app;

-- Tables created by future migrations inherit these grants automatically, so
-- this does not have to be remembered every time.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO health24_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO health24_app;
