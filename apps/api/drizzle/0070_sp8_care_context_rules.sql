-- SP8 Phase 3: what a linked visit is, and who may say so
-- (sp8-plan.md, T12, T13, T14).
--
-- Two tables and three guarantees:
--
--   1. A hospital sees its own links and nobody else's, and the patient sees
--      their own from the portal. Nothing here crosses a tenant boundary,
--      because a care context names a visit that a hospital holds.
--   2. A link is made once and can only be withdrawn. `linked -> unlinked` is
--      the only move; there is no route back, because re-linking is a fresh
--      decision by the patient and deserves a fresh row with its own date.
--   3. A linking request is asked once and answered once. Its content — which
--      visits, whose ABHA — is frozen the moment the patient is asked, so
--      that what they confirm is what was put to them.
--
-- The third is the one worth dwelling on. Without it, a request could be
-- asked with one visit, the patient could answer a code sent for that visit,
-- and the row could be widened to twenty visits before the confirmation was
-- processed. The guard makes `encounter_ids` immutable, so the code the
-- patient read out approves exactly what they were told about.

--------------------------------------------------------------------------------
-- 1. Row-level security
--------------------------------------------------------------------------------

ALTER TABLE "abdm_care_context" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "abdm_care_context" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The hospital that holds the visit, or the patient whose visit it is. A
-- consent artefact does not widen this: another hospital reading a record
-- under consent has no business knowing what the patient has shared with the
-- national network.
CREATE POLICY abdm_care_context_read ON "abdm_care_context"
  FOR SELECT
  USING (
    app.is_system()
    OR "hospital_id" = app.current_hospital_id()
    OR app.is_own_record("patient_id")
  );--> statement-breakpoint

CREATE POLICY abdm_care_context_write ON "abdm_care_context"
  FOR INSERT
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());--> statement-breakpoint

CREATE POLICY abdm_care_context_update ON "abdm_care_context"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());--> statement-breakpoint

ALTER TABLE "abdm_link_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "abdm_link_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- A linking request is the hospital's working state. The patient sees the
-- result — the care contexts — rather than the attempt, and in particular
-- never the hashed code.
CREATE POLICY abdm_link_request_tenant ON "abdm_link_request"
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. Integrity
--------------------------------------------------------------------------------

-- A withdrawal has a date, and a date means a withdrawal.
ALTER TABLE "abdm_care_context"
  ADD CONSTRAINT abdm_care_context_unlinked_consistently
  CHECK (("status" = 'unlinked') = ("unlinked_at" IS NOT NULL));--> statement-breakpoint

-- A link offered at the desk has a member of staff behind it; one the patient
-- made from their own app does not, and must not be attributed to anybody.
ALTER TABLE "abdm_care_context"
  ADD CONSTRAINT abdm_care_context_patient_link_unattributed
  CHECK ("initiated_by" <> 'patient' OR "linked_by_staff_id" IS NULL);--> statement-breakpoint

-- Linking nothing is not a request.
ALTER TABLE "abdm_link_request"
  ADD CONSTRAINT abdm_link_request_has_visits
  CHECK (array_length("encounter_ids", 1) >= 1);--> statement-breakpoint

ALTER TABLE "abdm_link_request"
  ADD CONSTRAINT abdm_link_request_confirmed_consistently
  CHECK (("status" = 'confirmed') = ("confirmed_at" IS NOT NULL));--> statement-breakpoint

-- The code lives as a keyed hash or not at all. Nothing writes it in clear,
-- and this refuses the row that would.
ALTER TABLE "abdm_link_request"
  ADD CONSTRAINT abdm_link_request_code_is_hashed
  CHECK ("code_hash" IS NULL OR "code_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3. Guards
--------------------------------------------------------------------------------

-- A link is withdrawn, never rewritten and never deleted: the dates are the
-- evidence of what this hospital exposed to the network and when.
CREATE TRIGGER abdm_care_context_guard
  BEFORE UPDATE OR DELETE ON "abdm_care_context"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:linked>unlinked', 'unlinked_at', 'unlinked_reason'
  );--> statement-breakpoint

-- Asked once, answered once. `encounter_ids` is absent from the mutable list
-- deliberately — see the note at the top of this file.
CREATE TRIGGER abdm_link_request_guard
  BEFORE UPDATE OR DELETE ON "abdm_link_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:pending>confirmed,pending>expired,pending>failed',
    'transaction_id',
    'confirmed_at',
    'failure_reason',
    'attempts:*',
    'code_hash'
  );
