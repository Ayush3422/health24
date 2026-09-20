-- SP5 Phase 8: the patient's copy of their own record (Decision N1).

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

ALTER TABLE "data_export"
  ADD CONSTRAINT data_export_status_known
  CHECK ("status" IN ('pending', 'ready', 'failed', 'expired'));

-- A ready export has both files and a life; a failed one says why.
ALTER TABLE "data_export"
  ADD CONSTRAINT data_export_ready_is_complete
  CHECK (
    ("status" IN ('ready', 'expired'))
      = ("pdf_key" IS NOT NULL AND "fhir_key" IS NOT NULL AND "ready_at" IS NOT NULL AND "expires_at" IS NOT NULL)
  );

ALTER TABLE "data_export"
  ADD CONSTRAINT data_export_failure_has_reason
  CHECK (("status" = 'failed') = ("failure_reason" IS NOT NULL));

-- Built once, by the worker; never rewritten, never deleted.
CREATE OR REPLACE FUNCTION app.guard_data_export() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an export expires; it is not deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."patient_id" IS DISTINCT FROM OLD."patient_id"
     OR NEW."requested_by_account_id" IS DISTINCT FROM OLD."requested_by_account_id"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" THEN
    RAISE EXCEPTION 'an export keeps who asked for it, and when'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (
    (OLD."status" = 'pending' AND NEW."status" IN ('pending', 'ready', 'failed'))
    OR (OLD."status" = 'ready' AND NEW."status" IN ('ready', 'expired'))
    OR (OLD."status" = NEW."status")
  ) THEN
    RAISE EXCEPTION 'an export goes from pending to ready or failed, and from ready to expired'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER data_export_guard
  BEFORE UPDATE OR DELETE ON "data_export"
  FOR EACH ROW EXECUTE FUNCTION app.guard_data_export();

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

-- The patient asks for an export and sees their own; the worker builds it in
-- system context. No hospital sees one: it is the patient's copy, not a
-- hospital's record.
ALTER TABLE "data_export" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_export" FORCE ROW LEVEL SECURITY;

CREATE POLICY data_export_system ON "data_export"
  USING (app.is_system())
  WITH CHECK (app.is_system());

CREATE POLICY data_export_own_read ON "data_export"
  FOR SELECT USING (app.is_own_record("patient_id"));

CREATE POLICY data_export_own_insert ON "data_export"
  FOR INSERT WITH CHECK (
    app.is_own_record("patient_id")
    AND "status" = 'pending'
    AND "pdf_key" IS NULL AND "fhir_key" IS NULL
  );

--------------------------------------------------------------------------------
-- 3. Grants
--------------------------------------------------------------------------------

-- Only the worker's system context reaches the update policy above.
REVOKE UPDATE, DELETE, TRUNCATE ON "data_export" FROM health24_app;
GRANT UPDATE ("status", "pdf_key", "fhir_key", "entry_count", "ready_at", "expires_at", "failure_reason")
  ON "data_export" TO health24_app;
