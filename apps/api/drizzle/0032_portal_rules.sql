-- SP5 Phase 1: the patient portal's identity rules, and the patient context.
--
-- A patient signed in to the portal reads their own record at every hospital,
-- without consent, because it is theirs (sp5-plan.md, DF4). The database
-- decides what "their own" means, as it decides a hospital's: the request sets
-- app.current_patient_id, never together with a hospital, and every read
-- policy admits the rows of that patient's record ids.

--------------------------------------------------------------------------------
-- 1. The patient context
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_patient_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_patient_id', true), '')::uuid $$;

-- True for a row of the signed-in patient's own record, across merged record
-- ids — and only in a patient context, never alongside a hospital's.
CREATE OR REPLACE FUNCTION app.is_own_record(p_patient_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT app.current_patient_id() IS NOT NULL
       AND app.current_hospital_id() IS NULL
       AND p_patient_id = ANY (app.patient_record_ids(app.current_patient_id()))
  $$;

GRANT EXECUTE ON FUNCTION app.current_patient_id() TO health24_app;
GRANT EXECUTE ON FUNCTION app.is_own_record(uuid) TO health24_app;

--------------------------------------------------------------------------------
-- 2. The patient's own record in every read policy
--------------------------------------------------------------------------------

ALTER POLICY allergy_intolerance_read ON "allergy_intolerance" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits("patient_id", 'allergies'::clinical_data_category, app.ist_date("recorded_at"))
  OR app.is_own_record("patient_id")
);

ALTER POLICY clinical_note_read ON "clinical_note" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits("patient_id", 'notes'::clinical_data_category, app.ist_date("recorded_at"))
  OR app.is_own_record("patient_id")
);

ALTER POLICY condition_read ON "condition" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits("patient_id", 'diagnoses'::clinical_data_category, app.ist_date("recorded_at"))
  OR app.is_own_record("patient_id")
);

ALTER POLICY encounter_read ON "encounter" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits("patient_id", 'encounters'::clinical_data_category, app.ist_date("started_at"))
  OR app.is_own_record("patient_id")
);

ALTER POLICY medication_request_read ON "medication_request" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits("patient_id", 'medications'::clinical_data_category, "start_date")
  OR app.is_own_record("patient_id")
);

ALTER POLICY observation_read ON "observation" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits("patient_id", 'observations'::clinical_data_category, app.ist_date("effective_at"))
  OR app.is_own_record("patient_id")
);

ALTER POLICY procedure_read ON "procedure" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits("patient_id", 'procedures'::clinical_data_category, app.ist_date("performed_at"))
  OR app.is_own_record("patient_id")
);

ALTER POLICY document_reference_read ON "document_reference" USING (
  app.is_system()
  OR "hospital_id" = app.current_hospital_id()
  OR app.consent_permits_category("patient_id", 'documents', "report_date")
  OR app.is_own_record("patient_id")
);

-- condition_coding and document_file follow their parent rows, so they need no branch.

-- The patient's own row, the hospitals they are linked to, their consents and
-- who read their record.
CREATE POLICY patient_own_read ON "patient"
  FOR SELECT USING (app.is_own_record("id"));

CREATE POLICY patient_hospital_link_own_read ON "patient_hospital_link"
  FOR SELECT USING (app.is_own_record("patient_id"));

CREATE POLICY consent_artefact_own_read ON "consent_artefact"
  FOR SELECT USING (app.is_own_record("patient_id"));

CREATE POLICY access_log_own_read ON "access_log"
  FOR SELECT USING (app.is_own_record("patient_id"));

--------------------------------------------------------------------------------
-- 3. Integrity
--------------------------------------------------------------------------------

ALTER TABLE "patient_account"
  ADD CONSTRAINT patient_account_phone_e164 CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE "patient_portal_access"
  ADD CONSTRAINT patient_portal_access_phone_e164 CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "patient_portal_access"
  ADD CONSTRAINT patient_portal_access_revoked_consistent
  CHECK (
    ("revoked_at" IS NULL) = ("revoked_by_staff_id" IS NULL)
    AND ("revoked_at" IS NULL) = ("revoked_reason" IS NULL)
    AND ("revoked_reason" IS NULL OR length(btrim("revoked_reason")) > 0)
  );
ALTER TABLE "patient_portal_access"
  ADD CONSTRAINT patient_portal_access_ends_after_activation
  CHECK ("ends_at" IS NULL OR "ends_at" > "activated_at");
-- A self access never ends by age; a guardian's always does.
ALTER TABLE "patient_portal_access"
  ADD CONSTRAINT patient_portal_access_ends_for_guardians
  CHECK (("relationship" = 'guardian') = ("ends_at" IS NOT NULL));

-- The phone copied onto an access is the account's own.
CREATE OR REPLACE FUNCTION app.check_portal_access_phone() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
  AS $$
DECLARE
  account_phone text;
BEGIN
  SELECT "phone" INTO account_phone FROM "patient_account" WHERE "id" = NEW."account_id";

  IF account_phone IS DISTINCT FROM NEW."phone" THEN
    RAISE EXCEPTION 'the phone on a portal access must be its account''s'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'patient_portal_access_phone_matches_account';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER patient_portal_access_phone
  BEFORE INSERT ON "patient_portal_access"
  FOR EACH ROW EXECUTE FUNCTION app.check_portal_access_phone();

ALTER TABLE "otp_challenge"
  ADD CONSTRAINT otp_challenge_attempts_bounded CHECK ("attempts" BETWEEN 0 AND 10);
ALTER TABLE "otp_challenge"
  ADD CONSTRAINT otp_challenge_expires_after_creation CHECK ("expires_at" > "created_at");

--------------------------------------------------------------------------------
-- 4. Who may activate, and what never changes
--------------------------------------------------------------------------------

-- The front desk, records staff or a clinician — who see the patient in person.
CREATE TRIGGER patient_portal_access_activated_by_staff
  BEFORE INSERT ON "patient_portal_access"
  FOR EACH ROW EXECUTE FUNCTION app.check_document_staff('activated_by_staff_id', 'activated_by_staff');

CREATE TRIGGER patient_portal_access_revoked_by_staff
  BEFORE UPDATE OF "revoked_by_staff_id" ON "patient_portal_access"
  FOR EACH ROW
  WHEN (NEW."revoked_by_staff_id" IS NOT NULL)
  EXECUTE FUNCTION app.check_document_staff('revoked_by_staff_id', 'revoked_by_staff');

-- Revoked once, never un-revoked; nothing else changes; nothing is deleted.
CREATE TRIGGER patient_portal_access_guard
  BEFORE UPDATE OR DELETE ON "patient_portal_access"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'revoked_at', 'revoked_by_staff_id', 'revoked_reason'
  );

--------------------------------------------------------------------------------
-- 5. Row-level security
--------------------------------------------------------------------------------

-- Accounts, codes and sessions are read and written only while signing in and
-- checking a session, in system context — as staff sign-in is.
ALTER TABLE "otp_challenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "otp_challenge" FORCE ROW LEVEL SECURITY;
CREATE POLICY otp_challenge_system_only ON "otp_challenge"
  USING (app.is_system()) WITH CHECK (app.is_system());

ALTER TABLE "patient_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_session" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_session_system_only ON "patient_session"
  USING (app.is_system()) WITH CHECK (app.is_system());

-- A portal access: seen and revoked by every hospital the patient is linked
-- to; activated by a hospital for a patient it holds; seen by the patient.
ALTER TABLE "patient_portal_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_portal_access" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_portal_access_read ON "patient_portal_access"
  FOR SELECT USING (
    app.is_system()
    OR EXISTS (
      SELECT 1 FROM "patient_hospital_link" l
       WHERE l."patient_id" = "patient_portal_access"."patient_id"
         AND l."hospital_id" = app.current_hospital_id()
    )
    OR app.is_own_record("patient_id")
  );
CREATE POLICY patient_portal_access_insert ON "patient_portal_access"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "activated_at_hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "patient_portal_access"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );
CREATE POLICY patient_portal_access_update ON "patient_portal_access"
  FOR UPDATE
  USING (
    app.is_system()
    OR EXISTS (
      SELECT 1 FROM "patient_hospital_link" l
       WHERE l."patient_id" = "patient_portal_access"."patient_id"
         AND l."hospital_id" = app.current_hospital_id()
    )
  )
  WITH CHECK (
    app.is_system()
    OR EXISTS (
      SELECT 1 FROM "patient_hospital_link" l
       WHERE l."patient_id" = "patient_portal_access"."patient_id"
         AND l."hospital_id" = app.current_hospital_id()
    )
  );

-- The desk needs an account for the phone it activates, without being able to
-- read or list accounts. This function finds or creates one, and nothing more.
-- It raises system context only for its own two statements and restores it.
CREATE OR REPLACE FUNCTION app.portal_account_for_phone(p_phone text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
  AS $$
DECLARE
  previous text := current_setting('app.system_context', true);
  found_id uuid;
BEGIN
  IF app.current_hospital_id() IS NULL THEN
    RAISE EXCEPTION 'a portal account is created by a hospital desk'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'not an E.164 phone number'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'patient_account_phone_e164';
  END IF;

  PERFORM set_config('app.system_context', 'on', true);

  BEGIN
    INSERT INTO "patient_account" ("id", "phone") VALUES (gen_random_uuid(), p_phone)
      ON CONFLICT ("phone") DO NOTHING;
    SELECT "id" INTO found_id FROM "patient_account" WHERE "phone" = p_phone;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.system_context', coalesce(previous, 'off'), true);
    RAISE;
  END;

  PERFORM set_config('app.system_context', coalesce(previous, 'off'), true);
  RETURN found_id;
END;
$$;

REVOKE ALL ON FUNCTION app.portal_account_for_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_account_for_phone(text) TO health24_app;

--------------------------------------------------------------------------------
-- 6. Grants
--------------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE
  ON "patient_account", "patient_portal_access", "otp_challenge", "patient_session"
  FROM health24_app;

GRANT UPDATE ("status", "last_login_at") ON "patient_account" TO health24_app;
GRANT UPDATE ("revoked_at", "revoked_by_staff_id", "revoked_reason")
  ON "patient_portal_access" TO health24_app;
GRANT UPDATE ("attempts", "consumed_at") ON "otp_challenge" TO health24_app;
GRANT UPDATE ("last_used_at", "revoked_at", "revoked_reason") ON "patient_session" TO health24_app;
