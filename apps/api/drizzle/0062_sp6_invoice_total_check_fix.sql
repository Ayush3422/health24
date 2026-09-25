-- SP6 Phase 7: the invoice total check, written so it can run on both tables.
--
-- The previous version picked the invoice id with a CASE over `TG_TABLE_NAME`.
-- PL/pgSQL resolves every field reference in an expression against the row it
-- is given, whichever branch is taken, so `NEW."invoice_id"` failed on the
-- invoice table itself — where there is no such column. An IF chooses between
-- two statements instead, and only the one that runs is resolved.
--
-- The local variable is renamed as well: called `invoice_id`, it shadowed the
-- column of that name in `invoice_line`, so the comparison would have read the
-- variable on both sides.

CREATE OR REPLACE FUNCTION app.check_invoice_total() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  target uuid;
  lines_total bigint;
  stated bigint;
BEGIN
  IF TG_TABLE_NAME = 'invoice' THEN
    target := NEW."id";
  ELSE
    target := NEW."invoice_id";
  END IF;

  SELECT "total_paise" INTO stated FROM "invoice" WHERE "id" = target;
  IF stated IS NULL THEN RETURN NULL; END IF;

  SELECT coalesce(sum("amount_paise"), 0) INTO lines_total
    FROM "invoice_line" WHERE "invoice_id" = target;

  IF stated <> lines_total THEN
    RAISE EXCEPTION 'invoice % states % but its lines come to %', target, stated, lines_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
