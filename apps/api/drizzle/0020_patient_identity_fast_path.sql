-- SP3 Phase 10 (T27): the timeline performance test found the cross-hospital
-- timeline over budget, and EXPLAIN put the cost here.
--
-- Every row another hospital reads is checked by app.consent_permits, which
-- calls app.patient_record_ids and, for each consent it considers,
-- app.canonical_patient_id — both recursive CTEs over patient_merge_alias. For
-- the patient nearly every row belongs to, one who was never merged, both
-- recursions find nothing, row after row.
--
-- A fast path answers that case with one index probe: a patient absent from
-- the alias table is their own canonical record and their only record id.
-- Merged patients take the same recursive walk as before, so the answers are
-- unchanged; clinical-rls.e2e-spec.ts "merged records" still covers them.
-- Measured on the synthetic volume: 264 ms to 54 ms for one table's rows.
--
-- CREATE OR REPLACE keeps the existing EXECUTE grants.

CREATE OR REPLACE FUNCTION app.canonical_patient_id(p_patient_id uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "patient_merge_alias" WHERE "merged_patient_id" = p_patient_id) THEN
    RETURN p_patient_id;
  END IF;

  RETURN (
    WITH RECURSIVE chain (id, depth) AS (
      SELECT p_patient_id, 0
      UNION ALL
      SELECT a."surviving_patient_id", chain.depth + 1
        FROM chain
        JOIN "patient_merge_alias" a ON a."merged_patient_id" = chain.id
       WHERE chain.depth < 16
    )
    SELECT id FROM chain ORDER BY depth DESC LIMIT 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.patient_record_ids(p_patient_id uuid) RETURNS uuid[]
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  canonical uuid := app.canonical_patient_id(p_patient_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "patient_merge_alias" WHERE "surviving_patient_id" = canonical) THEN
    RETURN ARRAY[canonical];
  END IF;

  RETURN (
    WITH RECURSIVE members (id, depth) AS (
      SELECT canonical, 0
      UNION ALL
      SELECT a."merged_patient_id", members.depth + 1
        FROM members
        JOIN "patient_merge_alias" a ON a."surviving_patient_id" = members.id
       WHERE members.depth < 16
    )
    SELECT array_agg(id) FROM members
  );
END;
$$;
