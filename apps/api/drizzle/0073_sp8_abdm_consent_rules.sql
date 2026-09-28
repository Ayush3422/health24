-- SP8 Phase 4: an ABDM consent in the consent model that already exists
-- (sp8-plan.md, T15, T16, DF2, DF3, Decision Y1).
--
-- The decision this file implements is that there is **one** answer to "who
-- may read this row", not two. A consent notified by the national consent
-- manager is a row in the same table as a consent recorded at a desk, and the
-- same function decides what it reveals.
--
-- The obstacle was that `app.consent_permits` was written for a hospital
-- reading another hospital's record: it matches on
-- `grantee_hospital_id = app.current_hospital_id()` and requires a link
-- between the patient and that hospital. ABDM's requester is neither — it is
-- not a hospital here, and it has no link to the patient.
--
-- What this does **not** do is add a second function and a second branch to
-- every clinical policy. It replaces `app.consent_permits` in place, so every
-- policy that already calls it picks up the new case and no policy is
-- touched. The old branch is copied across unchanged, and the sweep in
-- `clinical-rls.e2e-spec.ts` is what says so.
--
-- The new branch is reachable only in a context bound to **one** consent id
-- (DF3), which nothing but the assembly of a data request will ever set. A
-- hospital's ordinary request has no such context, so nothing a clinician
-- does can enter this branch, and an ABDM artefact can never widen what a
-- hospital sees — its `grantee_hospital_id` is null, and null matches no
-- hospital.

--------------------------------------------------------------------------------
-- 1. Exactly one grantee, and a source that matches it
--------------------------------------------------------------------------------

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_one_grantee
  CHECK (("grantee_hospital_id" IS NULL) <> ("grantee_abdm_hiu_id" IS NULL));--> statement-breakpoint

-- A consent from ABDM carries the consent manager's own id, and one that did
-- not come from ABDM does not. This is what makes redelivery idempotent: the
-- unique index on that column refuses the second write.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_source_matches_origin
  CHECK (
    ("source" = 'abdm') = ("abdm_consent_id" IS NOT NULL)
    AND ("source" = 'abdm') = ("grantee_abdm_hiu_id" IS NOT NULL)
    AND ("source" = 'abdm') = ("hip_hospital_id" IS NOT NULL)
    AND ("source" = 'abdm') = ("abdm_care_context_ids" IS NOT NULL)
  );--> statement-breakpoint

-- Nobody here recorded an ABDM consent, and the row must not pretend
-- otherwise. SP5's rule — exactly one recorder — becomes: exactly one for a
-- consent of ours, and none at all for one the consent manager notified.
ALTER TABLE "consent_artefact" DROP CONSTRAINT consent_artefact_one_recorder;--> statement-breakpoint

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_one_recorder
  CHECK (
    CASE
      WHEN "source" = 'abdm'
        THEN "recorded_by_staff_id" IS NULL AND "recorded_by_patient_account_id" IS NULL
      ELSE ("recorded_by_staff_id" IS NULL) <> ("recorded_by_patient_account_id" IS NULL)
    END
  );--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. The context an assembly runs in
--------------------------------------------------------------------------------

-- Set for the length of one transaction, by the code that builds a bundle for
-- one data request, and by nothing else. Never set alongside a hospital: an
-- assembly is not somebody's session, and a session is not an assembly.
CREATE OR REPLACE FUNCTION app.current_abdm_consent_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_abdm_consent_id', true), '')::uuid $$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.current_abdm_consent_id() TO health24_app;--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3. One function, two ways to satisfy it
--------------------------------------------------------------------------------

-- Security invoker, as before and for the same reason: it reads consent
-- artefacts under the caller's own row-level security. The first branch is
-- migration 0008's, unchanged. The second is this phase's.
CREATE OR REPLACE FUNCTION app.consent_permits(
  p_patient_id uuid,
  p_category clinical_data_category,
  p_on date
) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT
      -- A hospital reading another hospital's record under a consent granted
      -- to it, with the patient registered there (SP3, Decision A1).
      (app.current_hospital_id() IS NOT NULL AND EXISTS (
        SELECT 1
          FROM "consent_artefact" ca
          JOIN "patient_hospital_link" l
            ON l."patient_id" = app.canonical_patient_id(ca."patient_id")
           AND l."hospital_id" = ca."grantee_hospital_id"
         WHERE ca."grantee_hospital_id" = app.current_hospital_id()
           AND ca."patient_id" = ANY (app.patient_record_ids(p_patient_id))
           AND ca."status" = 'active'
           AND ca."expires_at" > now()
           AND p_category = ANY (ca."data_categories")
           AND (ca."date_range_from" IS NULL OR p_on >= ca."date_range_from")
           AND (ca."date_range_to" IS NULL OR p_on <= ca."date_range_to")
      ))
      OR
      -- Assembling the answer to one ABDM data request, bound to the single
      -- artefact that request rests on (SP8, DF3). No hospital link is
      -- required or wanted: the requester is not a hospital here.
      (app.current_abdm_consent_id() IS NOT NULL
       AND app.current_hospital_id() IS NULL
       AND EXISTS (
        SELECT 1
          FROM "consent_artefact" ca
         WHERE ca."id" = app.current_abdm_consent_id()
           AND ca."source" = 'abdm'
           AND ca."patient_id" = ANY (app.patient_record_ids(p_patient_id))
           AND ca."status" = 'active'
           AND ca."expires_at" > now()
           AND p_category = ANY (ca."data_categories")
           AND (ca."date_range_from" IS NULL OR p_on >= ca."date_range_from")
           AND (ca."date_range_to" IS NULL OR p_on <= ca."date_range_to")
      ))
  $$;--> statement-breakpoint

-- `app.consent_permits_category`, which the document policies call, is left
-- alone deliberately: 0022 defined it as a delegation to the function above,
-- so it gains the new case without being touched. That is the property this
-- whole approach was chosen for.

--------------------------------------------------------------------------------
-- 4. The patient row itself
--------------------------------------------------------------------------------

-- A bundle names the person it is about, so the assembly has to be able to
-- read the patient. It may read exactly the one the artefact is about, and
-- only while that artefact is in force — not every patient of the hospital
-- that holds it.
CREATE POLICY patient_abdm_assembly ON "patient"
  FOR SELECT
  USING (
    app.current_abdm_consent_id() IS NOT NULL
    AND app.current_hospital_id() IS NULL
    AND EXISTS (
      SELECT 1 FROM "consent_artefact" ca
       WHERE ca."id" = app.current_abdm_consent_id()
         AND ca."source" = 'abdm'
         AND ca."status" = 'active'
         AND ca."expires_at" > now()
         AND "patient"."id" = ANY (app.patient_record_ids(ca."patient_id"))
    )
  );--> statement-breakpoint

-- And the artefact itself must be readable in that context, or the checks
-- above find nothing and the whole assembly silently returns empty.
CREATE POLICY consent_artefact_abdm_assembly ON "consent_artefact"
  FOR SELECT
  USING ("id" = app.current_abdm_consent_id());--> statement-breakpoint

--------------------------------------------------------------------------------
-- 5. The hospital whose records are being shared
--------------------------------------------------------------------------------

-- It is not the grantee and never reads anything under this artefact, but it
-- is the one holding the record that leaves — so it can see that a national
-- requester has been allowed some of it, and for how long. Read only: this
-- consent is not the hospital's to revoke, and the update policies are
-- unchanged.
CREATE POLICY consent_artefact_hip_read ON "consent_artefact"
  FOR SELECT
  USING ("hip_hospital_id" = app.current_hospital_id());
