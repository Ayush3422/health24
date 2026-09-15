-- SP5 Phase 5: the patient's access history, and telling the patient of
-- emergency access (sp5-plan.md, DF6 and DF10).

--------------------------------------------------------------------------------
-- 1. Who read the record
--------------------------------------------------------------------------------

-- A staff member's role, for the patient's access history — under exactly the
-- conditions app.staff_name_for_patient gives their name (0034): in a patient
-- context, with no hospital context, for staff at a hospital where the patient
-- is registered. Nothing else about the staff member.
CREATE OR REPLACE FUNCTION app.staff_role_for_patient(p_staff_id uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
  AS $$
DECLARE
  previous text := current_setting('app.system_context', true);
  reader uuid := app.current_patient_id();
  found_role text;
BEGIN
  IF p_staff_id IS NULL OR reader IS NULL OR app.current_hospital_id() IS NOT NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.system_context', 'on', true);

  -- A failure here aborts the transaction, and system context with it.
  SELECT s."role"::text INTO found_role
    FROM "staff_user" s
   WHERE s."id" = p_staff_id
     AND EXISTS (
       SELECT 1 FROM "patient_hospital_link" l
        WHERE l."hospital_id" = s."hospital_id"
          AND l."patient_id" = ANY (app.patient_record_ids(reader))
     );

  PERFORM set_config('app.system_context', coalesce(previous, 'off'), true);
  RETURN found_role;
END;
$$;

REVOKE ALL ON FUNCTION app.staff_role_for_patient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.staff_role_for_patient(uuid) TO health24_app;

--------------------------------------------------------------------------------
-- 2. Telling the patient of emergency access
--------------------------------------------------------------------------------

-- The worker records when the patient was told, in system context. The
-- application role gains the column so it can; the guard keeps it set-once,
-- and this trigger keeps it the system's — a hospital cannot mark a patient
-- told, nor can a patient.
GRANT UPDATE ("patient_notified_at") ON "consent_artefact" TO health24_app;

CREATE OR REPLACE FUNCTION app.check_patient_notified_by_system() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."patient_notified_at" IS DISTINCT FROM OLD."patient_notified_at" AND NOT app.is_system() THEN
    RAISE EXCEPTION 'only the system records that a patient was told'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_artefact_patient_notified_by_system
  BEFORE UPDATE OF "patient_notified_at" ON "consent_artefact"
  FOR EACH ROW EXECUTE FUNCTION app.check_patient_notified_by_system();
