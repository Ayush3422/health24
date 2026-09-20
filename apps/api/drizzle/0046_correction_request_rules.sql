-- SP5 Phase 8: a patient asking a hospital to correct what it holds about
-- them (Decision N1).

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

ALTER TABLE "correction_request"
  ADD CONSTRAINT correction_request_field_known
  CHECK ("field" IN ('name', 'date_of_birth', 'gender', 'phone', 'blood_group',
                     'emergency_contact_name', 'emergency_contact_phone'));

ALTER TABLE "correction_request"
  ADD CONSTRAINT correction_request_status_known
  CHECK ("status" IN ('pending', 'applied', 'declined'));

ALTER TABLE "correction_request"
  ADD CONSTRAINT correction_request_asks_for_something
  CHECK (length(btrim("requested_value")) > 0);

-- Resolved once, by someone, with a reason when it is declined.
ALTER TABLE "correction_request"
  ADD CONSTRAINT correction_request_resolution_consistent
  CHECK (
    ("status" = 'pending') = ("resolved_at" IS NULL)
    AND ("resolved_at" IS NULL) = ("resolved_by_staff_id" IS NULL)
    AND ("status" <> 'declined' OR length(btrim(coalesce("resolution_note", ''))) > 0)
  );

CREATE TRIGGER correction_request_guard
  BEFORE UPDATE OR DELETE ON "correction_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:pending>applied', 'status:pending>declined',
    'resolved_by_staff_id', 'resolved_at', 'resolution_note'
  );

-- Resolved by staff of the hospital the request was sent to.
CREATE TRIGGER correction_request_resolved_by_staff
  BEFORE UPDATE OF "resolved_by_staff_id" ON "correction_request"
  FOR EACH ROW
  WHEN (NEW."resolved_by_staff_id" IS NOT NULL)
  EXECUTE FUNCTION app.check_document_staff('resolved_by_staff_id', 'resolved_by_staff');

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

-- The patient sees their own requests wherever they sent them; a hospital sees
-- and resolves the ones sent to it, for a patient it holds.
ALTER TABLE "correction_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "correction_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY correction_request_read ON "correction_request"
  FOR SELECT USING (
    app.is_system()
    OR "hospital_id" = app.current_hospital_id()
    OR app.is_own_record("patient_id")
  );

CREATE POLICY correction_request_own_insert ON "correction_request"
  FOR INSERT WITH CHECK (
    app.is_own_record("patient_id")
    AND "status" = 'pending'
    AND EXISTS (
      SELECT 1 FROM "patient_hospital_link" l
       WHERE l."hospital_id" = "correction_request"."hospital_id"
         AND l."patient_id" = ANY (app.patient_record_ids(app.current_patient_id()))
    )
  );

CREATE POLICY correction_request_hospital_update ON "correction_request"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

--------------------------------------------------------------------------------
-- 3. Grants
--------------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON "correction_request" FROM health24_app;
GRANT UPDATE ("status", "resolved_by_staff_id", "resolved_at", "resolution_note")
  ON "correction_request" TO health24_app;
