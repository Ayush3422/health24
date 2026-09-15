-- SP5 Phase 4: consent granted and revoked by the patient in the portal (Decision K1).
--
-- Comparisons against 'patient_portal' cast to text: the value joined the enum
-- in the previous migration, and Postgres refuses a newly added enum value as a
-- literal inside the transaction that added it.

--------------------------------------------------------------------------------
-- 1. Who recorded and who revoked
--------------------------------------------------------------------------------

-- Exactly one recorder: a hospital's staff member, or the patient's own portal
-- account — and a portal consent is always the patient's.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_one_recorder
  CHECK (("recorded_by_staff_id" IS NULL) <> ("recorded_by_patient_account_id" IS NULL));

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_portal_recorded_by_patient
  CHECK (("capture_method"::text = 'patient_portal') = ("recorded_by_patient_account_id" IS NOT NULL));

-- Revoked by staff or by the patient, never both.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_one_revoker
  CHECK ("revoked_by_staff_id" IS NULL OR "revoked_by_patient_account_id" IS NULL);

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

-- A hospital records consent given in person; it never records one as the
-- patient's own, nor marks one revoked by the patient.
ALTER POLICY consent_artefact_insert ON "consent_artefact"
  WITH CHECK (
    app.is_system()
    OR (
      "grantee_hospital_id" = app.current_hospital_id()
      AND "capture_method"::text <> 'patient_portal'
      AND "recorded_by_patient_account_id" IS NULL
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "consent_artefact"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );

ALTER POLICY consent_artefact_update ON "consent_artefact"
  USING (app.is_system() OR "grantee_hospital_id" = app.current_hospital_id())
  WITH CHECK (
    app.is_system()
    OR ("grantee_hospital_id" = app.current_hospital_id() AND "revoked_by_patient_account_id" IS NULL)
  );

-- A patient grants consent over their own record, in the portal, to a hospital
-- where they are registered.
CREATE POLICY consent_artefact_own_insert ON "consent_artefact"
  FOR INSERT WITH CHECK (
    app.is_own_record("patient_id")
    AND "capture_method"::text = 'patient_portal'
    AND "recorded_by_staff_id" IS NULL
    AND EXISTS (
      SELECT 1 FROM "patient_hospital_link" l
       WHERE l."hospital_id" = "consent_artefact"."grantee_hospital_id"
         AND l."patient_id" = ANY (app.patient_record_ids(app.current_patient_id()))
    )
  );

-- And revokes any consent over their own record, wherever it was recorded. The
-- guard and the column grants allow nothing but revocation; emergency access is
-- not consent, and is not the patient's to end.
CREATE POLICY consent_artefact_own_update ON "consent_artefact"
  FOR UPDATE
  USING (app.is_own_record("patient_id") AND "capture_method"::text <> 'break_glass')
  WITH CHECK (
    app.is_own_record("patient_id")
    AND "capture_method"::text <> 'break_glass'
    AND "revoked_by_staff_id" IS NULL
  );

--------------------------------------------------------------------------------
-- 3. Immutability and grants
--------------------------------------------------------------------------------

DROP TRIGGER consent_artefact_guard ON "consent_artefact";
CREATE TRIGGER consent_artefact_guard
  BEFORE UPDATE OR DELETE ON "consent_artefact"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:active>revoked', 'revoked_at', 'revoked_by_staff_id', 'revoked_by_patient_account_id',
    'revocation_reason', 'reviewed_at', 'reviewed_by_staff_id', 'review_outcome', 'review_note',
    'patient_notified_at'
  );

GRANT UPDATE ("revoked_by_patient_account_id") ON "consent_artefact" TO health24_app;
