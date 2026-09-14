-- SP3 Phase 8: consent recorded through the application, emergency access, and
-- the coding review queue.
--
-- Comparisons against 'break_glass' cast to text: the value joined the enum in
-- the previous migration, and Postgres refuses a newly added enum value as a
-- literal inside the transaction that added it.

--------------------------------------------------------------------------------
-- 1. Emergency access
--------------------------------------------------------------------------------

-- An emergency access always says why, and only an emergency access carries
-- an emergency reason.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_break_glass_has_reason
  CHECK (
    ("capture_method"::text = 'break_glass')
      = ("emergency_reason" IS NOT NULL AND length(btrim("emergency_reason")) > 0)
  );

-- Emergency access is brief by construction: a day at most.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_break_glass_is_brief
  CHECK ("capture_method"::text <> 'break_glass' OR "expires_at" <= "granted_at" + interval '24 hours');

-- A review is complete or absent, applies to emergency access alone, and is
-- never by the person who took the access.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_review_consistent
  CHECK (
    ("reviewed_at" IS NULL) = ("reviewed_by_staff_id" IS NULL)
    AND ("reviewed_at" IS NULL) = ("review_outcome" IS NULL)
    AND ("reviewed_at" IS NULL) = ("review_note" IS NULL)
    AND ("reviewed_at" IS NULL OR "capture_method"::text = 'break_glass')
    AND "reviewed_by_staff_id" IS DISTINCT FROM "recorded_by_staff_id"
  );

-- Reviewed by the grantee hospital's own staff.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_reviewed_by_grantee_staff_fk
  FOREIGN KEY ("reviewed_by_staff_id", "grantee_hospital_id")
  REFERENCES "staff_user" ("id", "hospital_id");

-- The review columns, and the patient notification, are set once.
DROP TRIGGER consent_artefact_guard ON "consent_artefact";
CREATE TRIGGER consent_artefact_guard
  BEFORE UPDATE OR DELETE ON "consent_artefact"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:active>revoked', 'revoked_at', 'revoked_by_staff_id', 'revocation_reason',
    'reviewed_at', 'reviewed_by_staff_id', 'review_outcome', 'review_note',
    'patient_notified_at'
  );

-- The patient is told by the portal (SP5), in system context; the application
-- role records reviews only.
GRANT UPDATE ("reviewed_at", "reviewed_by_staff_id", "review_outcome", "review_note")
  ON "consent_artefact" TO health24_app;

--------------------------------------------------------------------------------
-- 2. Coding review acknowledgements
--------------------------------------------------------------------------------

ALTER TABLE "coding_review_acknowledgement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coding_review_acknowledgement" FORCE ROW LEVEL SECURITY;

CREATE POLICY coding_review_acknowledgement_read ON "coding_review_acknowledgement"
  FOR SELECT USING (app.is_system() OR "hospital_id" = app.current_hospital_id());

-- Only for the hospital's own diagnoses: another hospital's coding is theirs to review.
CREATE POLICY coding_review_acknowledgement_insert ON "coding_review_acknowledgement"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "condition" c
         WHERE c."id" = "coding_review_acknowledgement"."condition_id"
           AND c."hospital_id" = "coding_review_acknowledgement"."hospital_id"
      )
    )
  );

CREATE TRIGGER coding_review_acknowledgement_guard
  BEFORE UPDATE OR DELETE ON "coding_review_acknowledgement"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row();

REVOKE UPDATE, DELETE, TRUNCATE ON "coding_review_acknowledgement" FROM health24_app;
