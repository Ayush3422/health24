-- SP8 Phase 5: what left the building, and who may see that it did
-- (sp8-plan.md, T23, T24, T25).
--
-- A data request is the record of a transfer, and it outlives the queue job
-- that performed it deliberately: a job that disappears cannot answer a
-- patient asking what left. So the row is append-and-settle — written once,
-- moved to exactly one outcome, and never rewritten.
--
-- `partly_transferred` is the outcome this table exists to be able to record.
-- A consent withdrawn while a transfer is running stops the rest, and what
-- has already gone cannot be recalled; a status that could only say "done" or
-- "failed" would describe that as neither.

--------------------------------------------------------------------------------
-- 1. Row-level security
--------------------------------------------------------------------------------

ALTER TABLE "abdm_data_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "abdm_data_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The hospital whose records left, and the patient whose records they were.
-- Nobody else: a requester does not read this, and another hospital has no
-- business knowing that this one answered a national request.
CREATE POLICY abdm_data_request_read ON "abdm_data_request"
  FOR SELECT
  USING (
    app.is_system()
    OR "hospital_id" = app.current_hospital_id()
    OR app.is_own_record("patient_id")
  );--> statement-breakpoint

-- Written and settled by the transfer itself, which runs as the system: it
-- is answering the national network rather than acting for a hospital, and
-- there is no session behind it to scope it to.
CREATE POLICY abdm_data_request_write ON "abdm_data_request"
  FOR INSERT WITH CHECK (app.is_system());--> statement-breakpoint

CREATE POLICY abdm_data_request_settle ON "abdm_data_request"
  FOR UPDATE USING (app.is_system()) WITH CHECK (app.is_system());--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. Integrity
--------------------------------------------------------------------------------

-- A finished transfer says when it finished; an unfinished one does not.
ALTER TABLE "abdm_data_request"
  ADD CONSTRAINT abdm_data_request_completed_consistently
  CHECK (("status" = 'pending') = ("completed_at" IS NULL));--> statement-breakpoint

-- Nothing can have been sent that was not asked for.
ALTER TABLE "abdm_data_request"
  ADD CONSTRAINT abdm_data_request_sent_within_requested
  CHECK ("care_contexts_sent" BETWEEN 0 AND "care_contexts_requested");--> statement-breakpoint

-- Each outcome has to agree with the count, because this table is what a
-- patient is shown when they ask what left.
--
-- `transferred` does not require that every visit produced a bundle: a
-- consent may admit nothing of one of them, and a transfer that ran to the
-- end having sent four of five visits is complete rather than partial. What
-- it does require is that something went — a run that sent nothing is
-- `refused`, with the reason saying whether that was the consent's scope or
-- its withdrawal.
ALTER TABLE "abdm_data_request"
  ADD CONSTRAINT abdm_data_request_outcome_matches_count
  CHECK (
    CASE "status"
      WHEN 'transferred' THEN "care_contexts_sent" > 0
      WHEN 'partly_transferred' THEN
        "care_contexts_sent" > 0 AND "care_contexts_sent" < "care_contexts_requested"
      WHEN 'refused' THEN "care_contexts_sent" = 0
      ELSE true
    END
  );--> statement-breakpoint

-- A request that did not succeed says why.
ALTER TABLE "abdm_data_request"
  ADD CONSTRAINT abdm_data_request_failure_explained
  CHECK ("status" NOT IN ('failed', 'refused', 'partly_transferred') OR "failure_reason" IS NOT NULL);--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3. The guard
--------------------------------------------------------------------------------

-- Settled once. The count and the outcome move together as the transfer runs,
-- and everything that says what was asked for — the consent, the patient, the
-- transaction, the key material, where it was pushed — is frozen.
CREATE TRIGGER abdm_data_request_guard
  BEFORE UPDATE OR DELETE ON "abdm_data_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:pending>transferred,pending>partly_transferred,pending>failed,pending>refused',
    'care_contexts_sent:*',
    'completed_at',
    'failure_reason'
  );
