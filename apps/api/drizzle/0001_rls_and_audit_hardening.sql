-- SP1: Row-level security, audit immutability, and matching support.
--
-- Three things happen here, in order of importance:
--
--   1. Tenant isolation is moved into the database. A query issued without a
--      tenant context returns nothing; a query issued with one returns only
--      that hospital's rows. A forgotten WHERE clause can no longer leak data
--      across hospitals — it can only return an empty set, which is loud and
--      safe rather than silent and catastrophic.
--
--   2. The audit log is made physically append-only, by trigger rather than by
--      grant, so it holds regardless of which role the application connects as.
--
--   3. Trigram indexing is enabled for patient name matching.

--------------------------------------------------------------------------------
-- Extensions
--------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

--------------------------------------------------------------------------------
-- Request context helpers
--------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;

-- The hospital whose data the current transaction may see. Set per request via
-- SET LOCAL, so it cannot survive into the next request that borrows the same
-- pooled connection.
CREATE OR REPLACE FUNCTION app.current_hospital_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_hospital_id', true), '')::uuid $$;

-- System context. Reserved for exactly four call sites: migrations, seeding,
-- the pre-authentication staff lookup (which cannot know a hospital yet), and
-- cross-hospital merge execution. Every other path must leave it off.
--
-- Note for production hardening: this is an in-application boundary. The
-- stronger form is a second database role without BYPASSRLS for request
-- traffic. That is a deployment change, not a schema change, so it can be made
-- later without touching this migration.
CREATE OR REPLACE FUNCTION app.is_system() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.system_context', true), 'off') = 'on' $$;

--------------------------------------------------------------------------------
-- Row-level security
--------------------------------------------------------------------------------

-- FORCE is required because the application may connect as the table owner,
-- and owners are exempt from RLS unless forced.

-- staff_user: a hospital sees its own staff. Platform admins (hospital_id null)
-- are visible only in system context.
ALTER TABLE "staff_user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_user" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_user_tenant_isolation ON "staff_user"
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

-- session: reachable only through its owning staff member.
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
CREATE POLICY session_tenant_isolation ON "session"
  USING (
    app.is_system()
    OR EXISTS (
      SELECT 1 FROM "staff_user" su
      WHERE su."id" = "session"."staff_user_id"
        AND su."hospital_id" = app.current_hospital_id()
    )
  )
  WITH CHECK (
    app.is_system()
    OR EXISTS (
      SELECT 1 FROM "staff_user" su
      WHERE su."id" = "session"."staff_user_id"
        AND su."hospital_id" = app.current_hospital_id()
    )
  );

-- patient_hospital_link: the link table is the visibility rule itself.
ALTER TABLE "patient_hospital_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_hospital_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_hospital_link_tenant_isolation ON "patient_hospital_link"
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

-- patient: the global spine. A hospital may see a person only where a link
-- row exists. From SP5, consent widens this; nothing here needs to change.
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_tenant_isolation ON "patient"
  USING (
    app.is_system()
    OR EXISTS (
      SELECT 1 FROM "patient_hospital_link" phl
      WHERE phl."patient_id" = "patient"."id"
        AND phl."hospital_id" = app.current_hospital_id()
    )
  )
  WITH CHECK (
    app.is_system()
    OR "created_by_hospital_id" = app.current_hospital_id()
  );

-- patient_account: portal credentials, visible only in system context. No
-- hospital ever reads a patient's login.
ALTER TABLE "patient_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_account_system_only ON "patient_account"
  USING (app.is_system())
  WITH CHECK (app.is_system());

-- patient_merge_candidate: visible to the hospital that surfaced the pairing.
ALTER TABLE "patient_merge_candidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_merge_candidate" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_merge_candidate_tenant_isolation ON "patient_merge_candidate"
  USING (app.is_system() OR "detected_by_hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "detected_by_hospital_id" = app.current_hospital_id());

-- patient_merge_log: written and read in system context only. A merge spans
-- hospitals by definition, so it cannot belong to one.
ALTER TABLE "patient_merge_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_merge_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_merge_log_system_only ON "patient_merge_log"
  USING (app.is_system())
  WITH CHECK (app.is_system());

-- patient_demographic_change
ALTER TABLE "patient_demographic_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_demographic_change" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_demographic_change_tenant_isolation ON "patient_demographic_change"
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

-- access_log: a hospital reads its own audit trail.
ALTER TABLE "access_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY access_log_tenant_isolation ON "access_log"
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id());
-- Inserts are always permitted. An audit write must never be the reason a
-- request fails, and must never be blocked by the context it is recording.
CREATE POLICY access_log_insert_always ON "access_log"
  FOR INSERT WITH CHECK (true);

--------------------------------------------------------------------------------
-- Audit immutability
--------------------------------------------------------------------------------

-- Enforced by trigger rather than by REVOKE, because the application may
-- connect as the table owner, and an owner's privileges cannot be revoked.
-- An attacker who reaches the API therefore cannot erase their own tracks.
CREATE OR REPLACE FUNCTION app.reject_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'access_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER access_log_no_update
  BEFORE UPDATE ON "access_log"
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

CREATE TRIGGER access_log_no_delete
  BEFORE DELETE ON "access_log"
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

-- The merge log is evidence too: correcting a merge is done by reverting it,
-- which writes new rows, never by editing history.
CREATE TRIGGER patient_merge_log_no_delete
  BEFORE DELETE ON "patient_merge_log"
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

--------------------------------------------------------------------------------
-- Matching support
--------------------------------------------------------------------------------

-- Trigram index over the normalised name, for fuzzy duplicate detection.
CREATE INDEX IF NOT EXISTS patient_name_normalized_trgm_idx
  ON "patient" USING gin ("name_normalized" gin_trgm_ops);

-- Partial index: the merge queue is almost always read for pending rows only.
CREATE INDEX IF NOT EXISTS patient_merge_candidate_pending_idx
  ON "patient_merge_candidate" ("detected_by_hospital_id", "detected_at")
  WHERE "status" = 'pending';

-- A person can only merge into one surviving record.
CREATE UNIQUE INDEX IF NOT EXISTS patient_merged_into_unique_idx
  ON "patient_merge_log" ("merged_patient_id")
  WHERE "reverted_at" IS NULL;
