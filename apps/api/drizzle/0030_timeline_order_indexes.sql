-- SP4 Phase 7: every timeline branch reads its newest rows by an index in time
-- order, stopping at the page size. Prescriptions and allergies had no index on
-- the time the timeline orders them by.

CREATE INDEX IF NOT EXISTS medication_request_patient_recorded_idx
  ON "medication_request" ("patient_id", "recorded_at");

CREATE INDEX IF NOT EXISTS allergy_intolerance_patient_recorded_idx
  ON "allergy_intolerance" ("patient_id", "recorded_at");
