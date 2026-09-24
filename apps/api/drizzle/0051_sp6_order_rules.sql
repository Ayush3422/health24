-- SP6 Phase 1: the rules an order lives under (sp6-plan.md, Decision O1, DF1, DF2).
--
-- An order is the hospital's own operational record: what it asked for, and
-- how far the work has got. It is not shared under consent, because consent
-- covers what was found about the patient, not the asking — and what the work
-- produced, the observation or the report, travels under the categories it
-- always did.
--
-- Nothing clinical is asserted by asking, so an order is never superseded. It
-- moves forward, or it is cancelled with a reason.

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

-- A result belongs to an order of the same patient and hospital.
ALTER TABLE "observation"
  ADD CONSTRAINT observation_service_request_same_record_fk
  FOREIGN KEY ("service_request_id", "patient_id", "hospital_id")
  REFERENCES "service_request" ("id", "patient_id", "hospital_id");

ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_service_request_same_record_fk
  FOREIGN KEY ("service_request_id", "patient_id", "hospital_id")
  REFERENCES "service_request" ("id", "patient_id", "hospital_id");

CREATE INDEX IF NOT EXISTS observation_service_request_idx
  ON "observation" ("service_request_id");
CREATE INDEX IF NOT EXISTS document_reference_service_request_idx
  ON "document_reference" ("service_request_id");

-- A code and the system it comes from travel together or not at all.
ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_code_has_system
  CHECK (("requested_code" IS NULL) = ("requested_code_system" IS NULL));

-- Each step is recorded whole: when it happened and who did it, or neither.
ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_collection_complete
  CHECK (("collected_at" IS NULL) = ("collected_by_staff_id" IS NULL));

ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_in_progress_complete
  CHECK (("in_progress_at" IS NULL) = ("in_progress_by_staff_id" IS NULL));

-- A cancelled order says who cancelled it and why; one that is not cancelled
-- says none of those things.
ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_cancellation_consistent
  CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by_staff_id" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_reason" IS NULL)
  );

-- The status and the trail of timestamps say the same thing.
ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_resulted_consistent
  CHECK (("status" = 'resulted') = ("resulted_at" IS NOT NULL));

ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_steps_after_ordering
  CHECK (
    ("collected_at" IS NULL OR "collected_at" >= "ordered_at")
    AND ("in_progress_at" IS NULL OR "in_progress_at" >= "ordered_at")
    AND ("resulted_at" IS NULL OR "resulted_at" >= "ordered_at")
    AND ("cancelled_at" IS NULL OR "cancelled_at" >= "ordered_at")
  );

-- A transcribed order names the clinician it belongs to; a direct one is the
-- orderer's own, as everywhere else in the record (Decision C).
ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_direct_entry_is_own
  CHECK ("entry_source" = 'transcribed' OR "ordered_by_staff_id" = "recorded_by_staff_id");

ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_collected_by_same_hospital_fk
  FOREIGN KEY ("collected_by_staff_id", "hospital_id")
  REFERENCES "staff_user" ("id", "hospital_id");

ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_in_progress_by_same_hospital_fk
  FOREIGN KEY ("in_progress_by_staff_id", "hospital_id")
  REFERENCES "staff_user" ("id", "hospital_id");

ALTER TABLE "service_request"
  ADD CONSTRAINT service_request_cancelled_by_same_hospital_fk
  FOREIGN KEY ("cancelled_by_staff_id", "hospital_id")
  REFERENCES "staff_user" ("id", "hospital_id");

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

ALTER TABLE "service_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_request" FORCE ROW LEVEL SECURITY;

-- The hospital that placed the order, and nobody else. No consent clause: see
-- the note at the top.
CREATE POLICY service_request_read ON "service_request"
  FOR SELECT USING (app.is_system() OR "hospital_id" = app.current_hospital_id());

CREATE POLICY service_request_insert ON "service_request"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "service_request"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );

CREATE POLICY service_request_update ON "service_request"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

--------------------------------------------------------------------------------
-- 3. Immutability
--------------------------------------------------------------------------------

-- Forward only: a sample is taken, the work begins, a result arrives. A lab
-- that never takes a sample goes straight to in progress or to resulted, and
-- anything not yet resulted can still be cancelled.
CREATE TRIGGER service_request_guard
  BEFORE UPDATE OR DELETE ON "service_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:ordered>collected,ordered>in_progress,ordered>resulted,ordered>cancelled,'
      'collected>in_progress,collected>resulted,collected>cancelled,'
      'in_progress>resulted,in_progress>cancelled',
    'reference',
    'collected_at', 'collected_by_staff_id',
    'in_progress_at', 'in_progress_by_staff_id',
    'resulted_at',
    'cancelled_at', 'cancelled_by_staff_id', 'cancelled_reason'
  );

REVOKE DELETE ON "service_request" FROM health24_app;
REVOKE UPDATE ON "service_request" FROM health24_app;

-- Updates only to the columns a step may write. The trigger decides which
-- moves are legal; these grants mean an attempt on anything else never
-- reaches it.
GRANT UPDATE (
  "status", "reference",
  "collected_at", "collected_by_staff_id",
  "in_progress_at", "in_progress_by_staff_id",
  "resulted_at",
  "cancelled_at", "cancelled_by_staff_id", "cancelled_reason"
) ON "service_request" TO health24_app;
