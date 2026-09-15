-- SP5 Phase 3: the names of the staff who treated a patient, for the portal.
--
-- A staff row is visible only to its own hospital (and to system context), so
-- in the patient context every join to "staff_user" finds nothing. A patient
-- may know who treated them: this returns a staff member's name — nothing else
-- about them — when the caller is in a patient context, with no hospital
-- context, and the staff member works at a hospital where that patient is
-- registered. It raises system context for its one statement and restores it.

CREATE OR REPLACE FUNCTION app.staff_name_for_patient(p_staff_id uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
  AS $$
DECLARE
  previous text := current_setting('app.system_context', true);
  reader uuid := app.current_patient_id();
  found_name text;
BEGIN
  IF p_staff_id IS NULL OR reader IS NULL OR app.current_hospital_id() IS NOT NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.system_context', 'on', true);

  -- A failure here aborts the transaction, and system context with it.
  SELECT s."name" INTO found_name
    FROM "staff_user" s
   WHERE s."id" = p_staff_id
     AND EXISTS (
       SELECT 1 FROM "patient_hospital_link" l
        WHERE l."hospital_id" = s."hospital_id"
          AND l."patient_id" = ANY (app.patient_record_ids(reader))
     );

  PERFORM set_config('app.system_context', coalesce(previous, 'off'), true);
  RETURN found_name;
END;
$$;

REVOKE ALL ON FUNCTION app.staff_name_for_patient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.staff_name_for_patient(uuid) TO health24_app;
