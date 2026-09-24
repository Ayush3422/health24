-- SP6 Phase 3: the rules wards, beds and stays live under (sp6-plan.md, P1).
--
-- Wards and beds are the hospital's own furniture; a stay is where a patient
-- actually lay, and belongs to the hospital that admitted them. None of it is
-- shared under consent: which bed somebody was in is not what another hospital
-- treating them needs, and the encounter itself already travels.
--
-- Two rules carry the whole design, and both are the database's, not the
-- application's: one open stay per encounter, and one open stay per bed.

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

-- A bed out of service says why; one in service does not pretend to.
ALTER TABLE "bed"
  ADD CONSTRAINT bed_blocked_has_reason
  CHECK ("status" = 'blocked' OR "blocked_reason" IS NULL);

-- A stay ends completely or not at all.
ALTER TABLE "bed_stay"
  ADD CONSTRAINT bed_stay_end_complete
  CHECK (("ended_at" IS NULL) = ("ended_by_staff_id" IS NULL));

ALTER TABLE "bed_stay"
  ADD CONSTRAINT bed_stay_ends_after_it_starts
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

ALTER TABLE "bed_stay"
  ADD CONSTRAINT bed_stay_ended_by_same_hospital_fk
  FOREIGN KEY ("ended_by_staff_id", "hospital_id")
  REFERENCES "staff_user" ("id", "hospital_id");

-- A patient is in one bed at a time, and a bed holds one patient at a time.
-- Partial unique indexes, so the history may hold as many closed stays as it
-- likes while only one of each may be open.
CREATE UNIQUE INDEX bed_stay_one_open_per_encounter
  ON "bed_stay" ("encounter_id") WHERE "ended_at" IS NULL;

CREATE UNIQUE INDEX bed_stay_one_open_per_bed
  ON "bed_stay" ("bed_id") WHERE "ended_at" IS NULL;

-- Only an inpatient or day-care admission puts someone in a bed. An outpatient
-- consultation does not, and a cancelled encounter never did.
CREATE OR REPLACE FUNCTION app.check_bed_stay_encounter() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  encounter_class text;
  encounter_status text;
BEGIN
  SELECT e."class"::text, e."status"::text
    INTO encounter_class, encounter_status
    FROM "encounter" e
   WHERE e."id" = NEW."encounter_id";

  IF encounter_class NOT IN ('inpatient', 'emergency') THEN
    RAISE EXCEPTION 'a bed stay belongs to an inpatient or emergency encounter, not %', encounter_class
      USING ERRCODE = 'check_violation';
  END IF;

  IF encounter_status = 'cancelled' THEN
    RAISE EXCEPTION 'that encounter was cancelled'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER bed_stay_encounter_check
  BEFORE INSERT ON "bed_stay"
  FOR EACH ROW EXECUTE FUNCTION app.check_bed_stay_encounter();

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ward', 'bed', 'bed_stay'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (
         app.is_system() OR "hospital_id" = app.current_hospital_id()
       )', t || '_read', t
    );

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
         app.is_system() OR "hospital_id" = app.current_hospital_id()
       )', t || '_insert', t
    );

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE
         USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
         WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id())',
      t || '_update', t
    );
  END LOOP;
END
$$;

-- A patient's own stays, for the portal: their record, at their hospitals.
CREATE POLICY bed_stay_own_read ON "bed_stay"
  FOR SELECT USING (app.is_own_record("patient_id"));

--------------------------------------------------------------------------------
-- 3. Immutability
--------------------------------------------------------------------------------

-- A ward is renamed and closed; a bed is taken out of service and brought
-- back. Neither is deleted: beds carry history, and history is not furniture.
REVOKE DELETE ON "ward", "bed", "bed_stay" FROM health24_app;

-- A stay is a fact about where somebody was. It is written when it starts and
-- closed when it ends; nothing else about it changes, ever.
CREATE TRIGGER bed_stay_guard
  BEFORE UPDATE OR DELETE ON "bed_stay"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'ended_at', 'ended_by_staff_id', 'moved_reason'
  );

REVOKE UPDATE ON "bed_stay" FROM health24_app;
GRANT UPDATE ("ended_at", "ended_by_staff_id", "moved_reason") ON "bed_stay" TO health24_app;
