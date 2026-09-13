-- SP3: consent-aware row-level security, and a clinical record that cannot be
-- edited or deleted.
--
-- In order of consequence:
--
--   1. Cross-hospital visibility is decided here, in the database. A clinical
--      row is visible to the hospital that recorded it, and to another
--      hospital only where an active, unexpired consent artefact granted to
--      that hospital covers the row's category and date (Decision A1). A
--      service that forgets to check consent returns less, never more.
--
--   2. Clinical content is immutable. A row may change only its lifecycle —
--      an encounter finishing, a medicine stopped, an entry superseded or
--      marked entered in error — and only forwards. Deletion is refused
--      outright. Enforced by trigger, which binds the owner too, and by
--      column grants, which stop the application before the trigger.
--
--   3. A correction is honest. An entry marked superseded must have a
--      successor that points at it, and a successor must mark its predecessor
--      superseded, checked at commit.
--
--   4. Merged patient records resolve through `patient_merge_alias`, so
--      consent granted against the surviving record covers rows recorded
--      against the merged one.

--------------------------------------------------------------------------------
-- 1. Merged records
--------------------------------------------------------------------------------

ALTER TABLE "patient_merge_alias"
  ADD CONSTRAINT patient_merge_alias_not_self
  CHECK ("merged_patient_id" <> "surviving_patient_id");

-- Identifiers only, so readable by every hospital. Written only by a merge
-- or its reversal, both of which run in system context.
ALTER TABLE "patient_merge_alias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_merge_alias" FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_merge_alias_read ON "patient_merge_alias"
  FOR SELECT USING (true);
CREATE POLICY patient_merge_alias_insert_system ON "patient_merge_alias"
  FOR INSERT WITH CHECK (app.is_system());
CREATE POLICY patient_merge_alias_delete_system ON "patient_merge_alias"
  FOR DELETE USING (app.is_system());

-- The record a patient id now lives under, following merges to the end of
-- the chain. The depth cap is a backstop; the merge service already refuses
-- to merge a record that has itself been merged.
CREATE OR REPLACE FUNCTION app.canonical_patient_id(p_patient_id uuid) RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    WITH RECURSIVE chain (id, depth) AS (
      SELECT p_patient_id, 0
      UNION ALL
      SELECT a."surviving_patient_id", chain.depth + 1
        FROM chain
        JOIN "patient_merge_alias" a ON a."merged_patient_id" = chain.id
       WHERE chain.depth < 16
    )
    SELECT id FROM chain ORDER BY depth DESC LIMIT 1
  $$;

-- Every patient id that belongs to the same person as the one given: the
-- canonical record and everything merged into it.
CREATE OR REPLACE FUNCTION app.patient_record_ids(p_patient_id uuid) RETURNS uuid[]
  LANGUAGE sql STABLE
  AS $$
    WITH RECURSIVE members (id, depth) AS (
      SELECT app.canonical_patient_id(p_patient_id), 0
      UNION ALL
      SELECT a."merged_patient_id", members.depth + 1
        FROM members
        JOIN "patient_merge_alias" a ON a."surviving_patient_id" = members.id
       WHERE members.depth < 16
    )
    SELECT array_agg(id) FROM members
  $$;

--------------------------------------------------------------------------------
-- 2. Consent
--------------------------------------------------------------------------------

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_has_categories
  CHECK (cardinality("data_categories") > 0);

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_date_range_ordered
  CHECK ("date_range_from" IS NULL OR "date_range_to" IS NULL OR "date_range_from" <= "date_range_to");

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_expires_after_grant
  CHECK ("expires_at" > "granted_at");

-- Verbal consent without a named witness is an unverifiable assertion.
ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_verbal_has_witness
  CHECK ("capture_method" <> 'verbal_witnessed' OR length(btrim(coalesce("witness_name", ''))) > 0);

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_revocation_consistent
  CHECK (
    ("status" = 'revoked') = ("revoked_at" IS NOT NULL)
    AND ("status" = 'active' OR "revocation_reason" IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS consent_artefact_active_idx
  ON "consent_artefact" ("grantee_hospital_id", "patient_id")
  WHERE "status" = 'active';

-- A hospital sees the consents granted to it. It may record one only for a
-- patient it is linked to — consent is asked of a patient who is present.
ALTER TABLE "consent_artefact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_artefact" FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_artefact_read ON "consent_artefact"
  FOR SELECT USING (app.is_system() OR "grantee_hospital_id" = app.current_hospital_id());
CREATE POLICY consent_artefact_insert ON "consent_artefact"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "grantee_hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "consent_artefact"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );
CREATE POLICY consent_artefact_update ON "consent_artefact"
  FOR UPDATE
  USING (app.is_system() OR "grantee_hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "grantee_hospital_id" = app.current_hospital_id());

-- A clinical date, as a date in India Standard Time. Consent date ranges are
-- calendar dates as the patient and the front desk understand them.
CREATE OR REPLACE FUNCTION app.ist_date(p_at timestamptz) RETURNS date
  LANGUAGE sql STABLE
  AS $$ SELECT (p_at AT TIME ZONE 'Asia/Kolkata')::date $$;

-- Whether the calling hospital may read another hospital's clinical row.
--
-- Security invoker, deliberately: it reads consent artefacts and links under
-- the caller's own row-level security, so it can only ever find consents
-- granted to the caller. A definer function here would be one mistake away
-- from finding everyone's.
CREATE OR REPLACE FUNCTION app.consent_permits(
  p_patient_id uuid,
  p_category clinical_data_category,
  p_on date
) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT app.current_hospital_id() IS NOT NULL AND EXISTS (
      SELECT 1
        FROM "consent_artefact" ca
        JOIN "patient_hospital_link" l
          ON l."patient_id" = app.canonical_patient_id(ca."patient_id")
         AND l."hospital_id" = ca."grantee_hospital_id"
       WHERE ca."grantee_hospital_id" = app.current_hospital_id()
         AND ca."patient_id" = ANY (app.patient_record_ids(p_patient_id))
         AND ca."status" = 'active'
         AND ca."expires_at" > now()
         AND p_category = ANY (ca."data_categories")
         AND (ca."date_range_from" IS NULL OR p_on >= ca."date_range_from")
         AND (ca."date_range_to" IS NULL OR p_on <= ca."date_range_to")
    )
  $$;

--------------------------------------------------------------------------------
-- 3. Clinical integrity
--------------------------------------------------------------------------------

ALTER TABLE "encounter"
  ADD CONSTRAINT encounter_ended_after_start
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");
ALTER TABLE "encounter"
  ADD CONSTRAINT encounter_end_matches_status
  CHECK (("status" = 'in_progress') = ("ended_at" IS NULL));
ALTER TABLE "encounter"
  ADD CONSTRAINT encounter_cancellation_has_reason
  CHECK ("status" <> 'cancelled' OR "status_reason" IS NOT NULL);

-- The clinician's own selection carries no equivalence and rests on no
-- mapping; anything attached from a map carries both.
ALTER TABLE "condition_coding"
  ADD CONSTRAINT condition_coding_primary_has_no_mapping
  CHECK (
    ("role" = 'primary') = ("equivalence" IS NULL)
    AND ("role" = 'primary') = ("concept_map_element_id" IS NULL)
  );
ALTER TABLE "condition_coding"
  ADD CONSTRAINT condition_coding_confidence_range
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "medication_request"
  ADD CONSTRAINT medication_request_has_name
  CHECK (length(btrim("medicine_name")) > 0);
ALTER TABLE "medication_request"
  ADD CONSTRAINT medication_request_dose_complete
  CHECK (("dose_quantity" IS NULL) = ("dose_unit" IS NULL) AND ("dose_quantity" IS NULL OR "dose_quantity" > 0));
ALTER TABLE "medication_request"
  ADD CONSTRAINT medication_request_duration_complete
  CHECK (("duration_value" IS NULL) = ("duration_unit" IS NULL) AND ("duration_value" IS NULL OR "duration_value" > 0));
ALTER TABLE "medication_request"
  ADD CONSTRAINT medication_request_code_complete
  CHECK (("medicine_code" IS NULL) = ("medicine_code_system" IS NULL));
ALTER TABLE "medication_request"
  ADD CONSTRAINT medication_request_end_matches_status
  CHECK (
    ("status" = 'active') = ("ended_at" IS NULL)
    AND ("status" <> 'stopped' OR ("ended_by_staff_id" IS NOT NULL AND "end_reason" IS NOT NULL))
  );

ALTER TABLE "allergy_intolerance"
  ADD CONSTRAINT allergy_intolerance_has_substance
  CHECK (length(btrim("substance")) > 0);

ALTER TABLE "observation"
  ADD CONSTRAINT observation_exactly_one_value
  CHECK (num_nonnulls("value_quantity", "value_text") = 1);

ALTER TABLE "clinical_note"
  ADD CONSTRAINT clinical_note_has_body
  CHECK (length(btrim("body")) > 0);

ALTER TABLE "procedure"
  ADD CONSTRAINT procedure_code_complete
  CHECK (("code" IS NULL) = ("code_system" IS NULL));

-- Versioning is consistent: a current row has no status change recorded; a
-- row that is no longer current says when, by whom and why.
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
         ("version_status" = ''current'') = ("status_changed_at" IS NULL)
         AND ("version_status" = ''current''
              OR ("status_changed_by_staff_id" IS NOT NULL AND "status_reason" IS NOT NULL))
       )',
      t, t || '_version_status_consistent'
    );

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ("supersedes_id" IS NULL OR "supersedes_id" <> "id")',
      t, t || '_not_self_superseding'
    );
  END LOOP;
END
$$;

--------------------------------------------------------------------------------
-- 4. Immutability
--------------------------------------------------------------------------------

-- One guard for every clinical table. Its arguments name the columns a row
-- may change; everything else is frozen.
--
--   'column:from>to,from>to'  a lifecycle column, with its permitted moves
--   'column'                  a set-once column: null to a value, then fixed
--
-- Deletion is always refused.
CREATE OR REPLACE FUNCTION app.guard_clinical_row() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  arg text;
  col text;
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
    mutable := mutable || col;

    IF position(':' IN arg) > 0 THEN
      IF (old_row ->> col) IS DISTINCT FROM (new_row ->> col)
         AND NOT (
           ((old_row ->> col) || '>' || (new_row ->> col))
             = ANY (string_to_array(split_part(arg, ':', 2), ','))
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

CREATE TRIGGER encounter_guard
  BEFORE UPDATE OR DELETE ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:in_progress>finished,in_progress>cancelled', 'ended_at', 'status_reason'
  );

CREATE TRIGGER condition_coding_guard
  BEFORE UPDATE OR DELETE ON "condition_coding"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row();

CREATE TRIGGER medication_request_guard
  BEFORE UPDATE OR DELETE ON "medication_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'version_status:current>superseded,current>entered_in_error',
    'status_changed_at', 'status_changed_by_staff_id', 'status_reason',
    'status:active>stopped,active>completed', 'ended_at', 'ended_by_staff_id', 'end_reason'
  );

CREATE TRIGGER consent_artefact_guard
  BEFORE UPDATE OR DELETE ON "consent_artefact"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:active>revoked', 'revoked_at', 'revoked_by_staff_id', 'revocation_reason'
  );

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'condition', 'allergy_intolerance', 'observation', 'clinical_note', 'procedure'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
           ''version_status:current>superseded,current>entered_in_error'',
           ''status_changed_at'', ''status_changed_by_staff_id'', ''status_reason''
         )',
      t || '_guard', t
    );
  END LOOP;
END
$$;

-- Supersession, checked at commit so the two halves of a correction can be
-- written in either order within one transaction.
CREATE OR REPLACE FUNCTION app.check_supersession() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  predecessor_status text;
  has_successor boolean;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    EXECUTE format('SELECT version_status::text FROM %I.%I WHERE id = $1',
                   TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO predecessor_status
      USING NEW.supersedes_id;

    IF predecessor_status IS DISTINCT FROM 'superseded' THEN
      RAISE EXCEPTION 'a correction to % must mark the entry it replaces as superseded', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.version_status = 'superseded' THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE supersedes_id = $1)',
                   TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO has_successor
      USING NEW.id;

    IF NOT has_successor THEN
      RAISE EXCEPTION 'an entry in % can be superseded only by a correction that points at it', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'condition', 'medication_request', 'allergy_intolerance',
    'observation', 'clinical_note', 'procedure'
  ] LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION app.check_supersession()',
      t || '_supersession', t
    );
  END LOOP;
END
$$;

--------------------------------------------------------------------------------
-- 5. Row-level security for clinical tables
--------------------------------------------------------------------------------

-- Reading: the owning hospital, or a hospital holding consent that covers the
-- row's category and clinical date.
-- Writing: the owning hospital only, and only for a patient it is linked to.
-- A hospital never writes into, or corrects, another hospital's record.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('encounter',           'encounters',   'app.ist_date("started_at")'),
      ('condition',           'diagnoses',    'app.ist_date("recorded_at")'),
      ('medication_request',  'medications',  '"start_date"'),
      ('allergy_intolerance', 'allergies',    'app.ist_date("recorded_at")'),
      ('observation',         'observations', 'app.ist_date("effective_at")'),
      ('clinical_note',       'notes',        'app.ist_date("recorded_at")'),
      ('procedure',           'procedures',   'app.ist_date("performed_at")')
    ) AS s (table_name, category, clinical_date)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', spec.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', spec.table_name);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (
         app.is_system()
         OR "hospital_id" = app.current_hospital_id()
         OR app.consent_permits("patient_id", %L, %s)
       )',
      spec.table_name || '_read', spec.table_name, spec.category, spec.clinical_date
    );

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
         app.is_system()
         OR (
           "hospital_id" = app.current_hospital_id()
           AND EXISTS (
             SELECT 1 FROM "patient_hospital_link" l
              WHERE l."patient_id" = %I."patient_id"
                AND l."hospital_id" = app.current_hospital_id()
           )
         )
       )',
      spec.table_name || '_insert', spec.table_name, spec.table_name
    );

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE
         USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
         WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id())',
      spec.table_name || '_update', spec.table_name
    );
  END LOOP;
END
$$;

-- A coding is visible exactly when its diagnosis is: the subquery is itself
-- subject to the condition table's policy.
ALTER TABLE "condition_coding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "condition_coding" FORCE ROW LEVEL SECURITY;
CREATE POLICY condition_coding_read ON "condition_coding"
  FOR SELECT USING (
    app.is_system()
    OR EXISTS (SELECT 1 FROM "condition" c WHERE c."id" = "condition_coding"."condition_id")
  );
CREATE POLICY condition_coding_insert ON "condition_coding"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR EXISTS (
      SELECT 1 FROM "condition" c
       WHERE c."id" = "condition_coding"."condition_id"
         AND c."hospital_id" = app.current_hospital_id()
    )
  );

--------------------------------------------------------------------------------
-- 6. Application role
--------------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION app.canonical_patient_id(uuid) TO health24_app;
GRANT EXECUTE ON FUNCTION app.patient_record_ids(uuid) TO health24_app;
GRANT EXECUTE ON FUNCTION app.ist_date(timestamptz) TO health24_app;
GRANT EXECUTE ON FUNCTION app.consent_permits(uuid, clinical_data_category, date) TO health24_app;

-- No deletes, anywhere in the clinical record.
REVOKE DELETE ON
  "encounter", "condition", "condition_coding", "medication_request",
  "allergy_intolerance", "observation", "clinical_note", "procedure",
  "consent_artefact"
FROM health24_app;

REVOKE UPDATE ON
  "encounter", "condition", "condition_coding", "medication_request",
  "allergy_intolerance", "observation", "clinical_note", "procedure",
  "consent_artefact", "patient_merge_alias"
FROM health24_app;

-- Updates only to lifecycle columns. The trigger decides which moves are
-- legal; these grants mean an attempt on anything else never reaches it.
GRANT UPDATE ("status", "ended_at", "status_reason") ON "encounter" TO health24_app;

GRANT UPDATE ("version_status", "status_changed_at", "status_changed_by_staff_id", "status_reason")
  ON "condition", "allergy_intolerance", "observation", "clinical_note", "procedure"
  TO health24_app;

GRANT UPDATE (
  "version_status", "status_changed_at", "status_changed_by_staff_id", "status_reason",
  "status", "ended_at", "ended_by_staff_id", "end_reason"
) ON "medication_request" TO health24_app;

GRANT UPDATE ("status", "revoked_at", "revoked_by_staff_id", "revocation_reason")
  ON "consent_artefact" TO health24_app;
