-- SP5 Phase 7: dependants (Decision M1). A child's record is linked to a
-- guardian's phone at the desk, and the link ends at the child's 18th birthday.

--------------------------------------------------------------------------------
-- 1. What a guardian's access records
--------------------------------------------------------------------------------

-- Who the guardian is, how they are related, and the document the desk checked;
-- a patient's own access records none of it.
ALTER TABLE "patient_portal_access"
  ADD CONSTRAINT patient_portal_access_guardian_details
  CHECK (
    ("relationship" = 'guardian') = ("guardian_name" IS NOT NULL)
    AND ("relationship" = 'guardian') = ("guardian_relation" IS NOT NULL)
    AND ("relationship" = 'guardian') = ("guardian_document" IS NOT NULL)
    AND ("guardian_relation" IS NULL OR "guardian_relation" IN ('mother', 'father', 'legal_guardian'))
    AND ("guardian_name" IS NULL OR length(btrim("guardian_name")) >= 2)
    AND ("guardian_document" IS NULL OR length(btrim("guardian_document")) >= 3)
  );

ALTER TABLE "patient_portal_access"
  ADD CONSTRAINT patient_portal_access_handover_for_guardians
  CHECK ("handed_over_at" IS NULL OR "relationship" = 'guardian');

--------------------------------------------------------------------------------
-- 2. Who links a guardian, for whom, and until when
--------------------------------------------------------------------------------

-- The front desk or records staff, who check the relationship and a document;
-- for a child whose date of birth is recorded; ending at midnight in India on
-- their 18th birthday. The date is the database's to decide, not the caller's.
CREATE OR REPLACE FUNCTION app.check_guardian_link() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
  AS $$
DECLARE
  previous text := current_setting('app.system_context', true);
  staff_role text;
  born date;
  adult_at timestamptz;
BEGIN
  IF NEW."relationship" <> 'guardian' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.system_context', 'on', true);

  SELECT s."role"::text INTO staff_role FROM "staff_user" s WHERE s."id" = NEW."activated_by_staff_id";
  SELECT p."date_of_birth" INTO born FROM "patient" p WHERE p."id" = NEW."patient_id";

  PERFORM set_config('app.system_context', coalesce(previous, 'off'), true);

  IF staff_role IS NULL OR staff_role NOT IN ('front_desk', 'medical_records') THEN
    RAISE EXCEPTION 'a guardian is linked by the front desk or records staff'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF born IS NULL THEN
    RAISE EXCEPTION 'a guardian link needs the child''s date of birth'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'patient_portal_access_guardian_needs_birth_date';
  END IF;

  adult_at := ((born + interval '18 years')::date::timestamp) AT TIME ZONE 'Asia/Kolkata';

  IF NEW."ends_at" IS DISTINCT FROM adult_at THEN
    RAISE EXCEPTION 'a guardian''s access ends at the child''s 18th birthday'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'patient_portal_access_guardian_ends_at_18';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER patient_portal_access_guardian_link
  BEFORE INSERT ON "patient_portal_access"
  FOR EACH ROW EXECUTE FUNCTION app.check_guardian_link();

--------------------------------------------------------------------------------
-- 3. The hand-over at 18: the system's, once
--------------------------------------------------------------------------------

DROP TRIGGER patient_portal_access_guard ON "patient_portal_access";
CREATE TRIGGER patient_portal_access_guard
  BEFORE UPDATE OR DELETE ON "patient_portal_access"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'revoked_at', 'revoked_by_staff_id', 'revoked_reason', 'handed_over_at'
  );

CREATE OR REPLACE FUNCTION app.check_handover_by_system() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at" AND NOT app.is_system() THEN
    RAISE EXCEPTION 'only the system hands a record over at 18'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER patient_portal_access_handover_by_system
  BEFORE UPDATE OF "handed_over_at" ON "patient_portal_access"
  FOR EACH ROW EXECUTE FUNCTION app.check_handover_by_system();

GRANT UPDATE ("handed_over_at") ON "patient_portal_access" TO health24_app;
