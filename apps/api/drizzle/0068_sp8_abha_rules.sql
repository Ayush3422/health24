-- SP8 Phase 1: a verified ABHA is not the same thing as a typed one
-- (sp8-plan.md, T1, T2).
--
-- Until now `patient.abha_number` was a string with no provenance, and
-- matching treated it as certainty: two records carrying the same number were
-- "the same person by definition". That is true of an ABHA the registry
-- confirmed. It is not true of fourteen digits a receptionist typed — and the
-- failure that actually happens in an Indian clinic is a parent's ABHA
-- entered for a child, which would have auto-linked the child's record into
-- the parent's and handed one person's history to another.
--
-- So the columns added in 0067 record when each identifier was confirmed and
-- by what method, and these rules keep that record honest:
--
--   1. A verification timestamp is written by `app.record_abha_verification`
--      and by nothing else, and the function stamps `now()` itself, so a
--      verification cannot be back-dated or invented by an ordinary update.
--   2. An identifier that has been verified cannot then be typed over.
--   3. A timestamp cannot exist without the identifier it refers to.
--
-- What rule 1 is, honestly: a guard against a mistake, not a privilege
-- boundary. The stronger form is column-level UPDATE on `patient`, which under
-- Postgres means revoking the table grant and enumerating every other column
-- here — and silently freezing any column added later. That trade is worse
-- than this one.
--
-- System context is exempt throughout. The merge, its reversal and erasure all
-- move identifiers between rows, they run as the system, and they are covered
-- by their own rules.

--------------------------------------------------------------------------------
-- 1. A timestamp implies the thing it is about
--------------------------------------------------------------------------------

ALTER TABLE "patient"
  ADD CONSTRAINT patient_abha_number_verified_has_number
  CHECK ("abha_number_verified_at" IS NULL OR "abha_number" IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "patient"
  ADD CONSTRAINT patient_abha_address_verified_has_address
  CHECK ("abha_address_verified_at" IS NULL OR "abha_address" IS NOT NULL);
--> statement-breakpoint

-- A verification has a method, and a method means a verification happened.
ALTER TABLE "patient"
  ADD CONSTRAINT patient_abha_verification_complete
  CHECK (
    ("abha_verification_method" IS NOT NULL)
      = ("abha_number_verified_at" IS NOT NULL OR "abha_address_verified_at" IS NOT NULL)
  );
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. The one way a verification is recorded
--------------------------------------------------------------------------------

-- Security invoker, deliberately: the UPDATE runs under the caller's own
-- row-level security, so this function can only ever touch a patient the
-- calling hospital may already see. It exists to stamp the time itself and to
-- raise the flag the guard below looks for — not to lend anybody privileges.
CREATE OR REPLACE FUNCTION app.record_abha_verification(
  p_patient_id uuid,
  p_abha_number text,
  p_abha_address text,
  p_method abha_verification_method,
  p_staff_id uuid
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
DECLARE
  previous text := current_setting('app.abha_verification', true);
  affected integer;
BEGIN
  IF p_abha_number IS NULL AND p_abha_address IS NULL THEN
    RAISE EXCEPTION 'A verification records an ABHA number, an ABHA address, or both'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  PERFORM set_config('app.abha_verification', 'on', true);

  BEGIN
    UPDATE "patient"
       SET "abha_number" = coalesce(p_abha_number, "abha_number"),
           "abha_address" = coalesce(p_abha_address, "abha_address"),
           -- Whichever identifier this verification covered is stamped now;
           -- the other keeps whatever standing it already had.
           "abha_number_verified_at" = CASE
             WHEN p_abha_number IS NULL THEN "abha_number_verified_at" ELSE now()
           END,
           "abha_address_verified_at" = CASE
             WHEN p_abha_address IS NULL THEN "abha_address_verified_at" ELSE now()
           END,
           "abha_verification_method" = p_method,
           "abha_verified_by_staff_id" = p_staff_id,
           "updated_at" = now()
     WHERE "id" = p_patient_id;

    GET DIAGNOSTICS affected = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.abha_verification', coalesce(previous, 'off'), true);
    RAISE;
  END;

  PERFORM set_config('app.abha_verification', coalesce(previous, 'off'), true);

  IF affected = 0 THEN
    RAISE EXCEPTION 'No patient with that id is visible to this hospital'
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  app.record_abha_verification(uuid, text, text, abha_verification_method, uuid)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  app.record_abha_verification(uuid, text, text, abha_verification_method, uuid)
  TO health24_app;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3. The guard
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.guard_abha_identity() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  verifying boolean := coalesce(current_setting('app.abha_verification', true), 'off') = 'on';
BEGIN
  IF app.is_system() OR verifying THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A patient is registered with what the desk was told. Nothing is
    -- verified at the moment of registration, because nobody has been asked
    -- to read a code back yet.
    IF NEW."abha_number_verified_at" IS NOT NULL
       OR NEW."abha_address_verified_at" IS NOT NULL
       OR NEW."abha_verification_method" IS NOT NULL
       OR NEW."abha_verified_by_staff_id" IS NOT NULL
    THEN
      RAISE EXCEPTION 'A patient cannot be registered with an ABHA already marked verified'
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Register the patient, then verify the ABHA with them present';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."abha_number_verified_at" IS DISTINCT FROM OLD."abha_number_verified_at"
     OR NEW."abha_address_verified_at" IS DISTINCT FROM OLD."abha_address_verified_at"
     OR NEW."abha_verification_method" IS DISTINCT FROM OLD."abha_verification_method"
     OR NEW."abha_verified_by_staff_id" IS DISTINCT FROM OLD."abha_verified_by_staff_id"
  THEN
    RAISE EXCEPTION 'An ABHA verification is recorded by app.record_abha_verification'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'An update cannot decide that an identifier was confirmed';
  END IF;

  IF OLD."abha_number_verified_at" IS NOT NULL
     AND NEW."abha_number" IS DISTINCT FROM OLD."abha_number"
  THEN
    RAISE EXCEPTION 'A verified ABHA number cannot be edited'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Verify the new ABHA against the registry rather than typing it';
  END IF;

  IF OLD."abha_address_verified_at" IS NOT NULL
     AND NEW."abha_address" IS DISTINCT FROM OLD."abha_address"
  THEN
    RAISE EXCEPTION 'A verified ABHA address cannot be edited'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Verify the new ABHA against the registry rather than typing it';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER patient_abha_guard
  BEFORE INSERT OR UPDATE ON "patient"
  FOR EACH ROW EXECUTE FUNCTION app.guard_abha_identity();
