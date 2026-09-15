-- SP5 Phase 6: the emergency card (Decision L1).

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

ALTER TABLE "emergency_card"
  ADD CONSTRAINT emergency_card_fields_known
  CHECK (
    cardinality("fields") > 0
    AND "fields" <@ ARRAY['blood_group', 'allergies', 'medicines', 'conditions', 'emergency_contact']::text[]
  );

ALTER TABLE "emergency_card"
  ADD CONSTRAINT emergency_card_revocation_consistent
  CHECK (("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL));

-- What may change is what the card shows, and its revocation, once. The link
-- never changes: a new link is a new card. Nothing is deleted.
CREATE OR REPLACE FUNCTION app.guard_emergency_card() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an emergency card is revoked, never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked emergency card does not change'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."patient_id" IS DISTINCT FROM OLD."patient_id"
     OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
     OR NEW."token_encrypted" IS DISTINCT FROM OLD."token_encrypted"
     OR NEW."created_by_account_id" IS DISTINCT FROM OLD."created_by_account_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'an emergency card keeps its link; replace the card for a new one'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER emergency_card_guard
  BEFORE UPDATE OR DELETE ON "emergency_card"
  FOR EACH ROW EXECUTE FUNCTION app.guard_emergency_card();

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

-- The patient's own cards, in the patient context. No hospital ever reads one.
ALTER TABLE "emergency_card" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emergency_card" FORCE ROW LEVEL SECURITY;

CREATE POLICY emergency_card_system ON "emergency_card"
  USING (app.is_system())
  WITH CHECK (app.is_system());

CREATE POLICY emergency_card_own_read ON "emergency_card"
  FOR SELECT USING (app.is_own_record("patient_id"));

CREATE POLICY emergency_card_own_insert ON "emergency_card"
  FOR INSERT WITH CHECK (app.is_own_record("patient_id") AND "revoked_at" IS NULL);

CREATE POLICY emergency_card_own_update ON "emergency_card"
  FOR UPDATE
  USING (app.is_own_record("patient_id"))
  WITH CHECK (app.is_own_record("patient_id"));

-- Opening a card from its QR code: the request identifies nobody, so there is
-- no context to read the card in. This finds the one card in use for a token's
-- hash, and nothing else — it cannot list cards, and a revoked link finds none.
CREATE OR REPLACE FUNCTION app.emergency_card_for_token(p_token_hash text)
  RETURNS TABLE (card_id uuid, card_patient_id uuid, card_fields text[], card_updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
  AS $$
DECLARE
  previous text := current_setting('app.system_context', true);
BEGIN
  IF p_token_hash IS NULL OR length(p_token_hash) < 40 THEN
    RETURN;
  END IF;

  PERFORM set_config('app.system_context', 'on', true);

  -- A failure here aborts the transaction, and system context with it.
  RETURN QUERY
    SELECT c."id", c."patient_id", c."fields", c."updated_at"
      FROM "emergency_card" c
     WHERE c."token_hash" = p_token_hash
       AND c."revoked_at" IS NULL;

  PERFORM set_config('app.system_context', coalesce(previous, 'off'), true);
END;
$$;

REVOKE ALL ON FUNCTION app.emergency_card_for_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.emergency_card_for_token(text) TO health24_app;

--------------------------------------------------------------------------------
-- 3. Grants
--------------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON "emergency_card" FROM health24_app;
GRANT UPDATE ("fields", "updated_at", "revoked_at", "revoked_by_account_id")
  ON "emergency_card" TO health24_app;
