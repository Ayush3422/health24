-- SP6 Phase 6: the catalogue and its charges (sp6-plan.md, Decision R1, DF3, DF5).
--
-- Money is integer paise, and the database is where that is enforced: an
-- amount is quantity × unit price or it is refused. A price is never
-- overwritten, so an invoice raised last month can be read against the price
-- that stood then, and a charge keeps the price it was captured at whatever
-- happens to the catalogue afterwards.
--
-- None of this crosses a hospital. Consent shares what was found about a
-- patient, not what they were billed (DF5).

--------------------------------------------------------------------------------
-- 1. The catalogue
--------------------------------------------------------------------------------

ALTER TABLE "service_catalogue_item"
  ADD CONSTRAINT service_catalogue_item_price_not_negative
  CHECK ("price_paise" >= 0);

ALTER TABLE "service_catalogue_item"
  ADD CONSTRAINT service_catalogue_item_period_ordered
  CHECK ("active_to" IS NULL OR "active_to" >= "active_from");

ALTER TABLE "service_catalogue_item"
  ADD CONSTRAINT service_catalogue_item_named
  CHECK (length(btrim("code")) > 0 AND length(btrim("name")) > 0);

-- One price in force at a time for a code. Two open-ended rows for the same
-- code would mean the hospital has two prices and no way to say which.
CREATE UNIQUE INDEX service_catalogue_item_one_in_force
  ON "service_catalogue_item" ("hospital_id", "code") WHERE "active_to" IS NULL;

--------------------------------------------------------------------------------
-- 2. Charges
--------------------------------------------------------------------------------

ALTER TABLE "charge"
  ADD CONSTRAINT charge_quantity_positive
  CHECK ("quantity" > 0);

-- The arithmetic, in the database. Nothing else may decide what a line comes
-- to: not the application, not a form, not a spreadsheet somebody pasted from.
ALTER TABLE "charge"
  ADD CONSTRAINT charge_amount_is_the_arithmetic
  CHECK ("amount_paise" = "quantity" * "unit_price_paise");

ALTER TABLE "charge"
  ADD CONSTRAINT charge_price_not_negative
  CHECK ("unit_price_paise" >= 0);

-- A voided charge says who voided it and why; one that is not voided says none
-- of those things.
ALTER TABLE "charge"
  ADD CONSTRAINT charge_void_consistent
  CHECK (
    ("status" = 'voided') = ("voided_at" IS NOT NULL)
    AND ("voided_at" IS NULL) = ("voided_by_staff_id" IS NULL)
    AND ("voided_at" IS NULL) = ("voided_reason" IS NULL)
  );

-- A charge is on an invoice exactly when it says it is invoiced.
ALTER TABLE "charge"
  ADD CONSTRAINT charge_invoiced_consistent
  CHECK (("status" = 'invoiced') = ("invoice_id" IS NOT NULL));

ALTER TABLE "charge"
  ADD CONSTRAINT charge_voided_by_same_hospital_fk
  FOREIGN KEY ("voided_by_staff_id", "hospital_id")
  REFERENCES "staff_user" ("id", "hospital_id");

-- A thing the record holds is charged once. A second dressing is a second
-- charge with no source, or a quantity of two — not the same order billed
-- twice by accident.
CREATE UNIQUE INDEX charge_source_once
  ON "charge" ("source_id") WHERE "source_id" IS NOT NULL AND "status" <> 'voided';

--------------------------------------------------------------------------------
-- 3. Row-level security
--------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_catalogue_item', 'charge'] LOOP
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
-- 4. Immutability
--------------------------------------------------------------------------------

-- A price row is closed, and nothing else about it changes: the code, the
-- name, the price and the day it started are what an old invoice is read
-- against.
CREATE TRIGGER service_catalogue_item_guard
  BEFORE UPDATE OR DELETE ON "service_catalogue_item"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row('active_to');

-- A charge is captured, then voided or invoiced. Its money never changes: a
-- wrong charge is voided and a right one captured.
CREATE TRIGGER charge_guard
  BEFORE UPDATE OR DELETE ON "charge"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:captured>voided,captured>invoiced',
    'voided_at', 'voided_by_staff_id', 'voided_reason', 'invoice_id'
  );

REVOKE DELETE ON "service_catalogue_item", "charge" FROM health24_app;
REVOKE UPDATE ON "service_catalogue_item", "charge" FROM health24_app;

GRANT UPDATE ("active_to") ON "service_catalogue_item" TO health24_app;
GRANT UPDATE ("status", "voided_at", "voided_by_staff_id", "voided_reason", "invoice_id")
  ON "charge" TO health24_app;
