-- SP6 Phase 4: the operative record and the devices in it (Decision Q1).
--
-- An implant is a clinical entry like any other: owned by the hospital that
-- recorded it, readable by another under a consent that covers procedures,
-- corrected by superseding and never edited. A recall a decade from now has to
-- find what was written at the time, not what somebody tidied it into.

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

-- A device names something, and its identifiers are optional but never blank.
ALTER TABLE "implant_device"
  ADD CONSTRAINT implant_device_has_name
  CHECK (length(btrim("name")) > 0);

ALTER TABLE "implant_device"
  ADD CONSTRAINT implant_device_identifiers_not_blank
  CHECK (
    ("serial_or_lot" IS NULL OR length(btrim("serial_or_lot")) > 0)
    AND ("model" IS NULL OR length(btrim("model")) > 0)
    AND ("manufacturer" IS NULL OR length(btrim("manufacturer")) > 0)
  );

-- The operation it belongs to is named as well as pointed at, so a correction
-- to the procedure cannot leave the device describing nothing.
ALTER TABLE "implant_device"
  ADD CONSTRAINT implant_device_procedure_named
  CHECK (("procedure_id" IS NULL) = ("procedure_name" IS NULL));

--------------------------------------------------------------------------------
-- 2. Row-level security
--------------------------------------------------------------------------------

ALTER TABLE "implant_device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "implant_device" FORCE ROW LEVEL SECURITY;

-- The owning hospital, a hospital holding consent that covers procedures, or
-- the patient themself in the portal — the same three readers as every other
-- clinical entry.
CREATE POLICY implant_device_read ON "implant_device"
  FOR SELECT USING (
    app.is_system()
    OR "hospital_id" = app.current_hospital_id()
    OR app.consent_permits("patient_id", 'procedures', app.ist_date("implanted_at"))
    OR app.is_own_record("patient_id")
  );

CREATE POLICY implant_device_insert ON "implant_device"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "implant_device"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );

CREATE POLICY implant_device_update ON "implant_device"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

--------------------------------------------------------------------------------
-- 3. Immutability
--------------------------------------------------------------------------------

CREATE TRIGGER implant_device_guard
  BEFORE UPDATE OR DELETE ON "implant_device"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'version_status:current>superseded,current>entered_in_error',
    'status_changed_at', 'status_changed_by_staff_id', 'status_reason'
  );

CREATE CONSTRAINT TRIGGER implant_device_supersession
  AFTER INSERT OR UPDATE ON "implant_device"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_supersession();

REVOKE DELETE ON "implant_device" FROM health24_app;
REVOKE UPDATE ON "implant_device" FROM health24_app;

GRANT UPDATE ("version_status", "status_changed_at", "status_changed_by_staff_id", "status_reason")
  ON "implant_device" TO health24_app;
