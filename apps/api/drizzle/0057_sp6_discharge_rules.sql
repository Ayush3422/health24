-- SP6 Phase 5: the discharge summary (sp6-plan.md, DF6 and DF7).
--
-- A draft is work in progress and is edited freely. Signing is what makes it a
-- record, and it writes two things that are: a versioned clinical note, and
-- the PDF the patient reads. After the signature this row never changes again.

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

-- A signature is whole: who signed it, when, and the two things it wrote.
ALTER TABLE "discharge_summary"
  ADD CONSTRAINT discharge_summary_signature_complete
  CHECK (
    ("status" = 'signed') = ("signed_at" IS NOT NULL)
    AND ("signed_at" IS NULL) = ("signed_by_staff_id" IS NULL)
    AND ("signed_at" IS NULL) = ("clinical_note_id" IS NULL)
    AND ("signed_at" IS NULL) = ("document_reference_id" IS NULL)
  );

ALTER TABLE "discharge_summary"
  ADD CONSTRAINT discharge_summary_signed_after_composed
  CHECK ("signed_at" IS NULL OR "signed_at" >= "composed_at");

ALTER TABLE "discharge_summary"
  ADD CONSTRAINT discharge_summary_note_same_record_fk
  FOREIGN KEY ("clinical_note_id", "patient_id", "hospital_id")
  REFERENCES "clinical_note" ("id", "patient_id", "hospital_id");

ALTER TABLE "discharge_summary"
  ADD CONSTRAINT discharge_summary_document_same_record_fk
  FOREIGN KEY ("document_reference_id", "patient_id", "hospital_id")
  REFERENCES "document_reference" ("id", "patient_id", "hospital_id");

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

ALTER TABLE "discharge_summary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discharge_summary" FORCE ROW LEVEL SECURITY;

-- The hospital that is writing it. What the signature produced travels
-- further: the note under a consent covering notes, the PDF as a document —
-- both by the rules those tables already have. An unsigned draft is nobody
-- else's business, and a signed one is read through them.
CREATE POLICY discharge_summary_read ON "discharge_summary"
  FOR SELECT USING (app.is_system() OR "hospital_id" = app.current_hospital_id());

CREATE POLICY discharge_summary_insert ON "discharge_summary"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "discharge_summary"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );

CREATE POLICY discharge_summary_update ON "discharge_summary"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

--------------------------------------------------------------------------------
-- 3. Immutability after the signature
--------------------------------------------------------------------------------

-- The one table here that is edited at all, and only while it is a draft.
-- `app.guard_clinical_row` cannot say "this may change until that happens", so
-- this says it instead.
CREATE OR REPLACE FUNCTION app.guard_discharge_summary() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a discharge summary is never deleted'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Leave the draft, or correct the note the signature wrote';
  END IF;

  IF OLD."status" = 'signed' THEN
    RAISE EXCEPTION 'a signed discharge summary cannot be changed'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Correct the clinical note the signature wrote';
  END IF;

  IF NEW."status" NOT IN ('draft', 'signed') THEN
    RAISE EXCEPTION 'a discharge summary is a draft or is signed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- What the summary is about never moves, whatever else is edited.
  IF NEW."encounter_id" IS DISTINCT FROM OLD."encounter_id"
     OR NEW."patient_id" IS DISTINCT FROM OLD."patient_id"
     OR NEW."hospital_id" IS DISTINCT FROM OLD."hospital_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'a discharge summary stays with the admission it was written for'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER discharge_summary_guard
  BEFORE UPDATE OR DELETE ON "discharge_summary"
  FOR EACH ROW EXECUTE FUNCTION app.guard_discharge_summary();

REVOKE DELETE ON "discharge_summary" FROM health24_app;
