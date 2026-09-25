-- SP6 Phase 9: the invoice counter only moves forward (sp6-plan.md, T23).
--
-- Migration 0061 said of the number series that it "is the one row here that
-- moves, and only forward" — and then left the application role able to move
-- it backwards, or to delete it outright. Either would hand a second invoice a
-- number that has already been issued, which is the one thing gapless
-- numbering exists to prevent.
--
-- Found by the row-level security sweep in Phase 9, which asks of every SP6
-- table what stops it being rewritten, and got no answer for this one.

CREATE OR REPLACE FUNCTION app.guard_invoice_counter() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An invoice number series is never deleted (%, %)',
      OLD."hospital_id", OLD."financial_year"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."hospital_id" <> OLD."hospital_id" OR NEW."financial_year" <> OLD."financial_year" THEN
    RAISE EXCEPTION 'An invoice number series does not move between hospitals or years'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Forward, one at a time, and never over the same number twice.
  IF NEW."next_number" <= OLD."next_number" THEN
    RAISE EXCEPTION 'An invoice number series only counts forward (% to %)',
      OLD."next_number", NEW."next_number"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_number_series_guard
  BEFORE UPDATE OR DELETE ON "invoice_number_series"
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_counter();

-- The counter row itself is never removed, and only its count may be touched.
REVOKE DELETE, UPDATE ON "invoice_number_series" FROM health24_app;
GRANT UPDATE ("next_number") ON "invoice_number_series" TO health24_app;
