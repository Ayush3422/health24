-- SP2: terminology search indexes, mapping integrity, and release immutability.
--
-- Three concerns, in order of consequence:
--
--   1. A published release never changes. Concepts, designations and maps are
--      immutable; a code system may change only its lifecycle. A code set that
--      shifts underneath records already coded against it is a data-integrity
--      failure, and ICD-11's CC BY-ND licence forbids adapting its content.
--
--   2. Mapping decisions are constrained by the database, not only the
--      service: an unmatched mapping has no target, a decision is dated, a
--      reviewer cannot approve their own proposal, and status moves only
--      forward.
--
--   3. Search is indexed on the folded designation.

--------------------------------------------------------------------------------
-- Lifecycle
--------------------------------------------------------------------------------

-- Exactly one active version per code system. Activation retires the previous
-- version first; this index is what makes forgetting to do so impossible.
CREATE UNIQUE INDEX IF NOT EXISTS code_system_one_active_per_key
  ON "code_system" ("key")
  WHERE "status" = 'active';

--------------------------------------------------------------------------------
-- Search
--------------------------------------------------------------------------------

-- Fuzzy matching over folded names: अम्लपित्त, amlapitta and a typo of either.
CREATE INDEX IF NOT EXISTS concept_designation_folded_trgm_idx
  ON "concept_designation" USING gin ("value_folded" gin_trgm_ops);

-- Prefix matching, for autocomplete as the clinician types.
CREATE INDEX IF NOT EXISTS concept_designation_folded_prefix_idx
  ON "concept_designation" ("value_folded" text_pattern_ops);

--------------------------------------------------------------------------------
-- Mapping integrity
--------------------------------------------------------------------------------

ALTER TABLE "concept_map_element"
  ADD CONSTRAINT concept_map_element_unmatched_has_no_target
  CHECK (("equivalence" = 'unmatched') = ("target_code" IS NULL));

ALTER TABLE "concept_map_element"
  ADD CONSTRAINT concept_map_element_confidence_range
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

-- A decision without a date cannot be placed in the audit history.
ALTER TABLE "concept_map_element"
  ADD CONSTRAINT concept_map_element_decision_is_dated
  CHECK ("status" NOT IN ('approved', 'rejected') OR "reviewed_at" IS NOT NULL);

-- Four-eyes review, enforced here as well as in the service. A curator who
-- proposes a mapping cannot be the one who approves it.
ALTER TABLE "concept_map_element"
  ADD CONSTRAINT concept_map_element_no_self_review
  CHECK (
    "reviewed_by_staff_id" IS NULL
    OR "proposed_by_staff_id" IS NULL
    OR "reviewed_by_staff_id" <> "proposed_by_staff_id"
  );

-- At most one approved and one proposed element per source/target pair. The
-- two may coexist, which is what lets a correction be proposed against a
-- mapping that stays approved until the correction itself is approved.
CREATE UNIQUE INDEX IF NOT EXISTS concept_map_element_one_approved_idx
  ON "concept_map_element" ("concept_map_id", "source_code", coalesce("target_code", ''))
  WHERE "status" = 'approved';

CREATE UNIQUE INDEX IF NOT EXISTS concept_map_element_one_proposed_idx
  ON "concept_map_element" ("concept_map_id", "source_code", coalesce("target_code", ''))
  WHERE "status" = 'proposed';

--------------------------------------------------------------------------------
-- Immutability
--------------------------------------------------------------------------------

-- Triggers rather than grants alone: they bind the owner too, so a release
-- cannot be edited from a psql session or a one-off script any more than from
-- the application.

CREATE OR REPLACE FUNCTION app.reject_terminology_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is immutable once imported: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Publish a new version of the release instead';
END;
$$;

CREATE TRIGGER concept_immutable
  BEFORE UPDATE OR DELETE ON "concept"
  FOR EACH ROW EXECUTE FUNCTION app.reject_terminology_mutation();

CREATE TRIGGER concept_designation_immutable
  BEFORE UPDATE OR DELETE ON "concept_designation"
  FOR EACH ROW EXECUTE FUNCTION app.reject_terminology_mutation();

CREATE TRIGGER concept_map_immutable
  BEFORE UPDATE OR DELETE ON "concept_map"
  FOR EACH ROW EXECUTE FUNCTION app.reject_terminology_mutation();

-- The review history is evidence and is append-only.
CREATE TRIGGER concept_map_review_append_only
  BEFORE UPDATE OR DELETE ON "concept_map_review"
  FOR EACH ROW EXECUTE FUNCTION app.reject_terminology_mutation();

-- A code system may change only its lifecycle: status, activation, retirement.
CREATE OR REPLACE FUNCTION app.guard_code_system_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'code_system is immutable once imported: DELETE is not permitted'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Retire the version instead';
  END IF;

  IF (NEW.key, NEW.uri, NEW.name, NEW.version, NEW.publisher, NEW.experimental,
      NEW.licence, NEW.attribution, NEW.released_at, NEW.content_hash,
      NEW.imported_at, NEW.imported_by)
     IS DISTINCT FROM
     (OLD.key, OLD.uri, OLD.name, OLD.version, OLD.publisher, OLD.experimental,
      OLD.licence, OLD.attribution, OLD.released_at, OLD.content_hash,
      OLD.imported_at, OLD.imported_by)
  THEN
    RAISE EXCEPTION 'code_system content is immutable once imported; only its lifecycle may change'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Publish a new version instead';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER code_system_guard
  BEFORE UPDATE OR DELETE ON "code_system"
  FOR EACH ROW EXECUTE FUNCTION app.guard_code_system_change();

-- A mapping may change only its review state, and only forwards:
--   proposed → approved | rejected
--   approved → retired
-- Its content never changes. A correction is a new element that supersedes
-- the old one, so the history of what was believed, and when, survives.
CREATE OR REPLACE FUNCTION app.guard_map_element_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concept_map_element cannot be deleted'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Retire or reject the mapping instead';
  END IF;

  IF (NEW.concept_map_id, NEW.source_code, NEW.target_code, NEW.equivalence,
      NEW.confidence, NEW.comment, NEW.provenance, NEW.proposed_by_staff_id,
      NEW.supersedes_element_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.concept_map_id, OLD.source_code, OLD.target_code, OLD.equivalence,
      OLD.confidence, OLD.comment, OLD.provenance, OLD.proposed_by_staff_id,
      OLD.supersedes_element_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'a mapping''s content is immutable'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Propose a correction that supersedes it';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'a mapping cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER concept_map_element_guard
  BEFORE UPDATE OR DELETE ON "concept_map_element"
  FOR EACH ROW EXECUTE FUNCTION app.guard_map_element_change();

--------------------------------------------------------------------------------
-- Application role
--------------------------------------------------------------------------------

-- Migration 0002's default privileges granted the application full DML on new
-- tables. Narrow that. The running application reads terminology, records
-- curation decisions, and changes a release's lifecycle — it never publishes
-- or edits a release. Imports run from the CLI as the owner.
REVOKE INSERT, UPDATE, DELETE ON "concept", "concept_designation", "concept_map" FROM health24_app;
REVOKE INSERT, DELETE ON "code_system" FROM health24_app;
REVOKE DELETE ON "concept_map_element" FROM health24_app;
REVOKE UPDATE, DELETE ON "concept_map_review" FROM health24_app;
