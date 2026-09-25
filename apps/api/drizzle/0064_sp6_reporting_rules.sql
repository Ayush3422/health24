-- SP6 Phase 8: reporting (sp6-plan.md, Decision S1, DF9, DF10).
--
-- Reports are counted from the operational tables under the hospital's own
-- row-level security, so a report cannot show one hospital another's numbers
-- — the same policies that decide what a clinician may read decide what a
-- report may count.
--
-- Two tables of their own: a summary of days that are over, and the returns
-- the hospital has sent to the ministry.

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

ALTER TABLE "daily_summary"
  ADD CONSTRAINT daily_summary_named
  CHECK (length(btrim("metric")) > 0 AND length(btrim("dimension")) > 0);

-- Today is never summarised: a day that has not ended can still change, and a
-- kept number that is still moving is worse than no number at all. That cannot
-- be a check constraint — `now()` is not immutable, and Postgres rightly
-- refuses one that reads the clock — so the service enforces it, and every
-- report counts today live rather than trusting a row for it.

ALTER TABLE "statutory_return"
  ADD CONSTRAINT statutory_return_period_ordered
  CHECK ("period_to" >= "period_from");

-- A submission is whole: when it was sent, and by whom.
ALTER TABLE "statutory_return"
  ADD CONSTRAINT statutory_return_submission_complete
  CHECK (("submitted_at" IS NULL) = ("submitted_by_staff_id" IS NULL));

ALTER TABLE "statutory_return"
  ADD CONSTRAINT statutory_return_submitted_after_generated
  CHECK ("submitted_at" IS NULL OR "submitted_at" >= "generated_at");

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['daily_summary', 'statutory_return'] LOOP
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

--------------------------------------------------------------------------------
-- 3. Immutability
--------------------------------------------------------------------------------

/*
 * The guard gains one marker: `column:*`, a column that may change freely.
 *
 * Everything it protected until now was either set once or moved along a
 * lifecycle, and both were expressible. A summarised day is neither: it is
 * counted again when a late correction lands, so its value moves, while
 * everything that says which day and which hospital it is must not. The
 * existing arguments mean exactly what they meant before.
 */
CREATE OR REPLACE FUNCTION app.guard_clinical_row() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  arg text;
  col text;
  rule text;
  mutable text[] := '{}';
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Mark the entry entered in error, or supersede it with a correction';
  END IF;

  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);

  FOREACH arg IN ARRAY coalesce(TG_ARGV, '{}'::text[]) LOOP
    col := split_part(arg, ':', 1);
    rule := split_part(arg, ':', 2);
    mutable := mutable || col;

    IF rule = '*' THEN
      CONTINUE;
    ELSIF position(':' IN arg) > 0 THEN
      IF (old_row ->> col) IS DISTINCT FROM (new_row ->> col)
         AND NOT (
           ((old_row ->> col) || '>' || (new_row ->> col)) = ANY (string_to_array(rule, ','))
         )
      THEN
        RAISE EXCEPTION '%.% cannot move from % to %',
          TG_TABLE_NAME, col, old_row ->> col, coalesce(new_row ->> col, 'null')
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF (old_row ->> col) IS NOT NULL
          AND (old_row ->> col) IS DISTINCT FROM (new_row ->> col)
    THEN
      RAISE EXCEPTION '%.% is set once and cannot be changed', TG_TABLE_NAME, col
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;

  IF (old_row - mutable) IS DISTINCT FROM (new_row - mutable) THEN
    RAISE EXCEPTION 'the content of % is immutable', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Record a correction that supersedes it';
  END IF;

  RETURN NEW;
END;
$$;

-- A summarised day is counted once. Recounting one is allowed — a day may be
-- summarised before a late correction lands — so the value and the moment it
-- was counted may move, and nothing else may.
CREATE TRIGGER daily_summary_guard
  BEFORE UPDATE OR DELETE ON "daily_summary"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row('value:*', 'counted_at:*');

-- What was submitted is kept exactly as it was sent: the rows never change,
-- and the submission is recorded once.
CREATE TRIGGER statutory_return_guard
  BEFORE UPDATE OR DELETE ON "statutory_return"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'submitted_at', 'submitted_by_staff_id', 'reference'
  );

REVOKE DELETE ON "daily_summary", "statutory_return" FROM health24_app;
REVOKE UPDATE ON "daily_summary", "statutory_return" FROM health24_app;

GRANT UPDATE ("value", "counted_at") ON "daily_summary" TO health24_app;
GRANT UPDATE ("submitted_at", "submitted_by_staff_id", "reference")
  ON "statutory_return" TO health24_app;
