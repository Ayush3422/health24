-- SP4 Phase 7: the timeline reads vital signs and lab results as separate
-- branches. With one index for both, each branch scanned the other category's
-- rows too, evaluating row-level security (and so consent) on every one before
-- discarding it: the lab branch alone added ~140 ms to another hospital's first
-- page at the performance test's volume. A partial index per category keeps
-- each branch to its own rows.

CREATE INDEX IF NOT EXISTS observation_patient_laboratory_idx
  ON "observation" ("patient_id", "effective_at")
  WHERE "category" = 'laboratory';

CREATE INDEX IF NOT EXISTS observation_patient_vital_signs_idx
  ON "observation" ("patient_id", "effective_at")
  WHERE "category" = 'vital_signs';
