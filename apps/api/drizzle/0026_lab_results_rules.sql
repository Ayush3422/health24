-- SP4 Phase 4: lab results as observations.
--
-- A lab value is a fact typed from a report, not a clinical decision, and the
-- front desk may type it (sp4-plan.md, DF7, Decision H1). So a laboratory
-- observation is attributed to whoever typed it, while a vital sign keeps its
-- clinician. The previous migration made attributed_clinician_id nullable;
-- these rules say exactly when it may be null.

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

-- A result belongs to a report of the same patient and hospital.
ALTER TABLE "observation"
  ADD CONSTRAINT observation_document_same_record_fk
  FOREIGN KEY ("document_id", "patient_id", "hospital_id")
  REFERENCES "document_reference" ("id", "patient_id", "hospital_id");

CREATE INDEX IF NOT EXISTS observation_document_idx ON "observation" ("document_id");
CREATE INDEX IF NOT EXISTS observation_patient_category_code_idx
  ON "observation" ("patient_id", "category", "code", "effective_at");

-- Vitals are a clinician's; lab results are nobody's decision, and are typed directly.
ALTER TABLE "observation"
  ADD CONSTRAINT observation_attribution_by_category
  CHECK (("category" = 'vital_signs') = ("attributed_clinician_id" IS NOT NULL));
ALTER TABLE "observation"
  ADD CONSTRAINT observation_laboratory_entered_directly
  CHECK ("category" = 'vital_signs' OR "entry_source" = 'direct');

-- A lab result is a number, from a panel, with its value in the canonical unit.
ALTER TABLE "observation"
  ADD CONSTRAINT observation_laboratory_complete
  CHECK (
    "category" = 'vital_signs'
    OR (
      "panel_code" IS NOT NULL AND "value_quantity" IS NOT NULL
      AND "value_canonical" IS NOT NULL AND "unit_canonical" IS NOT NULL
    )
  );

-- The laboratory columns stay empty on a vital sign.
ALTER TABLE "observation"
  ADD CONSTRAINT observation_vital_sign_plain
  CHECK (
    "category" = 'laboratory'
    OR (
      "panel_code" IS NULL AND "document_id" IS NULL AND "reference_low" IS NULL
      AND "reference_high" IS NULL AND "reference_text" IS NULL AND "interpretation" IS NULL
      AND "lab_flag" IS NULL AND "value_canonical" IS NULL AND "unit_canonical" IS NULL
      AND "performing_facility" IS NULL
    )
  );

ALTER TABLE "observation"
  ADD CONSTRAINT observation_reference_range_ordered
  CHECK ("reference_low" IS NULL OR "reference_high" IS NULL OR "reference_low" <= "reference_high");
ALTER TABLE "observation"
  ADD CONSTRAINT observation_canonical_pair
  CHECK (("value_canonical" IS NULL) = ("unit_canonical" IS NULL));

--------------------------------------------------------------------------------
-- 2. Who may type a lab result
--------------------------------------------------------------------------------

-- As migration 0015's function, with one branch first: a laboratory
-- observation is typed by the front desk, records staff or a clinician, and
-- carries no attribution to check.
CREATE OR REPLACE FUNCTION app.check_clinical_attribution() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  attributed_role text;
  entered_role text;
BEGIN
  IF TG_TABLE_NAME = 'observation' AND (to_jsonb(NEW) ->> 'category') = 'laboratory' THEN
    SELECT role::text INTO entered_role FROM "staff_user" WHERE id = NEW.recorded_by_staff_id;

    IF entered_role IS NOT NULL
       AND entered_role NOT IN ('clinician', 'front_desk', 'medical_records')
    THEN
      RAISE EXCEPTION 'lab results are typed by the front desk, records staff or a clinician'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'observation_laboratory_recorded_by_staff';
    END IF;

    RETURN NEW;
  END IF;

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
