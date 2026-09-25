-- SP6 Phase 7: invoices and the money ledger (sp6-plan.md, Decision R1, DF4).
--
-- Three properties make this worth having, and all three are the database's:
--
--   1. An invoice is never edited and never deleted. A mistake is corrected by
--      a credit note, which is another entry in the ledger.
--   2. Its total is the sum of its lines, checked at commit — not a number the
--      application promised to keep in step.
--   3. The ledger is append-only. Money taken, money returned, money written
--      off: added, never changed.
--
-- There is no paid flag anywhere. What is outstanding is arithmetic over the
-- ledger, so a status can never disagree with what was actually paid.

--------------------------------------------------------------------------------
-- 1. Numbering
--------------------------------------------------------------------------------

ALTER TABLE "invoice_number_series"
  ADD CONSTRAINT invoice_number_series_counts_from_one
  CHECK ("next_number" >= 1);

ALTER TABLE "invoice"
  ADD CONSTRAINT invoice_number_not_blank
  CHECK (length(btrim("number")) > 0 AND length(btrim("financial_year")) > 0);

/*
 * The next number in a hospital's series for a financial year.
 *
 * Deliberately not a sequence: a sequence does not roll back, so a failed
 * transaction would leave a hole, and a gap in an invoice series is the first
 * thing a tax officer asks about. This takes a row lock inside the caller's
 * transaction, so the number and the invoice are written together or not at
 * all — at the cost of serialising invoicing within one hospital, which is
 * exactly the trade a hospital wants.
 */
CREATE OR REPLACE FUNCTION app.next_invoice_number(hospital uuid, year text)
  RETURNS integer
  LANGUAGE plpgsql
  AS $$
DECLARE
  taken integer;
BEGIN
  INSERT INTO "invoice_number_series" ("hospital_id", "financial_year", "next_number")
  VALUES (hospital, year, 2)
  ON CONFLICT ("hospital_id", "financial_year")
    DO UPDATE SET "next_number" = "invoice_number_series"."next_number" + 1
  RETURNING CASE WHEN xmax = 0 THEN 1 ELSE "next_number" - 1 END INTO taken;

  RETURN taken;
END;
$$;

GRANT EXECUTE ON FUNCTION app.next_invoice_number(uuid, text) TO health24_app;

--------------------------------------------------------------------------------
-- 2. The arithmetic
--------------------------------------------------------------------------------

ALTER TABLE "invoice"
  ADD CONSTRAINT invoice_total_not_negative
  CHECK ("total_paise" >= 0);

ALTER TABLE "invoice_line"
  ADD CONSTRAINT invoice_line_amount_is_the_arithmetic
  CHECK ("amount_paise" = "quantity" * "unit_price_paise" AND "quantity" > 0);

ALTER TABLE "payment_entry"
  ADD CONSTRAINT payment_entry_amount_positive
  CHECK ("amount_paise" > 0);

-- A credit note moves no money, so it has no method; anything that does, has one.
ALTER TABLE "payment_entry"
  ADD CONSTRAINT payment_entry_method_matches_kind
  CHECK (("kind" = 'credit_note') = ("method" IS NULL));

ALTER TABLE "invoice_insurance"
  ADD CONSTRAINT invoice_insurance_approved_not_negative
  CHECK ("approved_paise" IS NULL OR "approved_paise" >= 0);

-- The total is the sum of the lines. Checked at commit, so the invoice and its
-- lines may be written in either order inside one transaction.
CREATE OR REPLACE FUNCTION app.check_invoice_total() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  invoice_id uuid;
  lines_total bigint;
  stated bigint;
BEGIN
  invoice_id := CASE TG_TABLE_NAME WHEN 'invoice' THEN NEW."id" ELSE NEW."invoice_id" END;

  SELECT "total_paise" INTO stated FROM "invoice" WHERE "id" = invoice_id;
  IF stated IS NULL THEN RETURN NULL; END IF;

  SELECT coalesce(sum("amount_paise"), 0) INTO lines_total
    FROM "invoice_line" WHERE "invoice_id" = invoice_id;

  IF stated <> lines_total THEN
    RAISE EXCEPTION 'invoice % states % but its lines come to %', invoice_id, stated, lines_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER invoice_total_matches_lines
  AFTER INSERT OR UPDATE ON "invoice"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_invoice_total();

CREATE CONSTRAINT TRIGGER invoice_line_total_matches
  AFTER INSERT OR UPDATE ON "invoice_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_invoice_total();

--------------------------------------------------------------------------------
-- 3. Row-level security
--------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invoice_number_series', 'invoice', 'invoice_line', 'payment_entry', 'invoice_insurance'
  ] LOOP
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
  END LOOP;
END
$$;

-- The counter is the one row here that moves, and only forward.
CREATE POLICY invoice_number_series_update ON "invoice_number_series"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

-- An invoice gains its PDF once, and nothing else about it ever changes.
CREATE POLICY invoice_update ON "invoice"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

--------------------------------------------------------------------------------
-- 4. Immutability
--------------------------------------------------------------------------------

CREATE TRIGGER invoice_guard
  BEFORE UPDATE OR DELETE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row('document_reference_id');

-- Lines, ledger entries and insurance rows are written once and never touched.
CREATE TRIGGER invoice_line_guard
  BEFORE UPDATE OR DELETE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row();

CREATE TRIGGER payment_entry_guard
  BEFORE UPDATE OR DELETE ON "payment_entry"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row();

CREATE TRIGGER invoice_insurance_guard
  BEFORE UPDATE OR DELETE ON "invoice_insurance"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row();

REVOKE DELETE, UPDATE ON "invoice", "invoice_line", "payment_entry", "invoice_insurance"
  FROM health24_app;

GRANT UPDATE ("document_reference_id") ON "invoice" TO health24_app;
GRANT UPDATE ("next_number") ON "invoice_number_series" TO health24_app;
