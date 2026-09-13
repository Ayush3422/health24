-- SP3 Phase 5: who typed a clinical entry, and whose decision it is.
--
-- Decision C: medical records staff transcribe from the doctor's file, on
-- behalf of a named clinician of the same hospital. Every entry now carries
-- both people. The rules, enforced here as well as in the services:
--
--   - An entry is attributed to a clinician. Always.
--   - A direct entry is attributed to the person who entered it; when the
--     attribution is left out, it is filled in.
--   - A transcribed entry is typed by medical records staff, for someone else.
--   - The attributed clinician belongs to the same hospital — already
--     enforced by the composite foreign keys in migration 0014.

--------------------------------------------------------------------------------
-- Consistency of source and attribution
--------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'condition', 'medication_request', 'allergy_intolerance',
    'observation', 'clinical_note', 'procedure'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (
         ("entry_source" = ''direct'') = ("attributed_clinician_id" = "recorded_by_staff_id")
       )',
      t, t || '_entry_source_consistent'
    );
  END LOOP;
END
$$;

ALTER TABLE "encounter"
  ADD CONSTRAINT encounter_entry_source_consistent
  CHECK (("entry_source" = 'direct') = ("attending_staff_id" = "recorded_by_staff_id"));

--------------------------------------------------------------------------------
-- Roles of the people named
--------------------------------------------------------------------------------

-- Roles are read under the caller's row-level security. Staff the caller
-- cannot see belong to another hospital, and the same-hospital foreign keys
-- refuse those with a precise error — so an invisible row is left to them
-- rather than reported vaguely here.
CREATE OR REPLACE FUNCTION app.check_clinical_attribution() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  attributed_role text;
  entered_role text;
BEGIN
  IF NEW.attributed_clinician_id IS NULL AND NEW.entry_source = 'direct' THEN
    NEW.attributed_clinician_id := NEW.recorded_by_staff_id;
  END IF;

  SELECT role::text INTO attributed_role FROM "staff_user" WHERE id = NEW.attributed_clinician_id;
  SELECT role::text INTO entered_role FROM "staff_user" WHERE id = NEW.recorded_by_staff_id;

  IF attributed_role IS NOT NULL AND attributed_role <> 'clinician' THEN
    RAISE EXCEPTION '% entries must be attributed to a clinician', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_TABLE_NAME || '_attributed_to_clinician';
  END IF;

  IF NEW.entry_source = 'transcribed' AND entered_role IS NOT NULL
     AND entered_role <> 'medical_records'
  THEN
    RAISE EXCEPTION 'only medical records staff transcribe entries into %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_TABLE_NAME || '_transcribed_by_records_staff';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.check_encounter_attribution() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  attending_role text;
  entered_role text;
BEGIN
  IF NEW.recorded_by_staff_id IS NULL AND NEW.entry_source = 'direct' THEN
    NEW.recorded_by_staff_id := NEW.attending_staff_id;
  END IF;

  SELECT role::text INTO attending_role FROM "staff_user" WHERE id = NEW.attending_staff_id;
  SELECT role::text INTO entered_role FROM "staff_user" WHERE id = NEW.recorded_by_staff_id;

  IF attending_role IS NOT NULL AND attending_role <> 'clinician' THEN
    RAISE EXCEPTION 'an encounter must be attended by a clinician'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_attended_by_clinician';
  END IF;

  IF NEW.entry_source = 'transcribed' AND entered_role IS NOT NULL
     AND entered_role <> 'medical_records'
  THEN
    RAISE EXCEPTION 'only medical records staff open encounters on a clinician''s behalf'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_transcribed_by_records_staff';
  END IF;

  RETURN NEW;
END;
$$;

-- Insert only. Attribution is content, and content never changes afterwards
-- (the guard triggers from migration 0008).
CREATE TRIGGER encounter_attribution
  BEFORE INSERT ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION app.check_encounter_attribution();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'condition', 'medication_request', 'allergy_intolerance',
    'observation', 'clinical_note', 'procedure'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I
         FOR EACH ROW EXECUTE FUNCTION app.check_clinical_attribution()',
      t || '_attribution', t
    );
  END LOOP;
END
$$;
