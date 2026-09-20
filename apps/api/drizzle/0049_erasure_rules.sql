-- SP5 Phase 8: erasure requests, decided by Health24's data-protection
-- officer (Decision N1).

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

ALTER TABLE "erasure_request"
  ADD CONSTRAINT erasure_request_status_known
  CHECK ("status" IN ('pending', 'decided'));

ALTER TABLE "erasure_request"
  ADD CONSTRAINT erasure_request_outcome_known
  CHECK ("outcome" IS NULL OR "outcome" IN ('erased', 'partly_erased', 'refused'));

-- A decision says who made it, when, what was decided, and what law requires
-- be kept. A refusal erases nothing, so it has nothing to summarise.
ALTER TABLE "erasure_request"
  ADD CONSTRAINT erasure_request_decision_consistent
  CHECK (
    ("status" = 'decided') = ("decided_at" IS NOT NULL)
    AND ("decided_at" IS NULL) = ("decided_by_staff_id" IS NULL)
    AND ("decided_at" IS NULL) = ("outcome" IS NULL)
    AND ("decided_at" IS NULL OR length(btrim(coalesce("retention_note", ''))) > 0)
    AND ("outcome" IS DISTINCT FROM 'refused' OR "erased_summary" IS NULL)
  );

CREATE TRIGGER erasure_request_guard
  BEFORE UPDATE OR DELETE ON "erasure_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:pending>decided', 'decided_by_staff_id', 'decided_at', 'outcome',
    'retention_note', 'erased_summary'
  );

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

-- The patient asks and sees their own. The data-protection officer works in
-- system context, as platform administration does — no hospital sees these.
ALTER TABLE "erasure_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "erasure_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY erasure_request_system ON "erasure_request"
  USING (app.is_system())
  WITH CHECK (app.is_system());

CREATE POLICY erasure_request_own_read ON "erasure_request"
  FOR SELECT USING (app.is_own_record("patient_id"));

CREATE POLICY erasure_request_own_insert ON "erasure_request"
  FOR INSERT WITH CHECK (app.is_own_record("patient_id") AND "status" = 'pending');

--------------------------------------------------------------------------------
-- 3. Carrying out an erasure
--------------------------------------------------------------------------------

-- Portal access is revoked at a desk by staff who see the patient — and, from
-- SP5, by the system carrying out an erasure the data-protection officer
-- decided. The officer belongs to no hospital, so the desk check is skipped
-- when the system is acting.
DROP TRIGGER patient_portal_access_revoked_by_staff ON "patient_portal_access";
CREATE TRIGGER patient_portal_access_revoked_by_staff
  BEFORE UPDATE OF "revoked_by_staff_id" ON "patient_portal_access"
  FOR EACH ROW
  WHEN (NEW."revoked_by_staff_id" IS NOT NULL AND NOT app.is_system())
  EXECUTE FUNCTION app.check_document_staff('revoked_by_staff_id', 'revoked_by_staff');

--------------------------------------------------------------------------------
-- 4. Grants
--------------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON "erasure_request" FROM health24_app;
GRANT UPDATE ("status", "decided_by_staff_id", "decided_at", "outcome", "retention_note", "erased_summary")
  ON "erasure_request" TO health24_app;
