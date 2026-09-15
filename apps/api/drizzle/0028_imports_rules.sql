-- SP4 Phase 6: legacy import (Decision E1) under the document rules —
-- integrity, who may classify, immutability, row-level security and grants.
--
-- An import file is the original as uploaded, scanned like any upload and
-- never served to a clinician. A page is cut from a file only once it scanned
-- clean. A page becomes part of one document of its own batch, or is excluded
-- with a reason: once, and never both. Nothing is shared with another
-- hospital, and nothing is deleted.

--------------------------------------------------------------------------------
-- 1. Integrity
--------------------------------------------------------------------------------

ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_position_from_one CHECK ("position" >= 1);
ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_mime_type_allowed
  CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'));
ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_size_bounded CHECK ("size_bytes" BETWEEN 1 AND 26214400);
ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_sha256_hex CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_page_count_positive CHECK ("page_count" IS NULL OR "page_count" >= 1);

-- Identifiers alone, naming this row's own hospital, patient and batch.
ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_storage_key_names_record
  CHECK (
    "storage_key" ~ '^hospitals/[0-9a-f-]{36}/patients/[0-9a-f-]{36}/imports/[0-9a-f-]{36}/files/[0-9a-f-]{36}$'
    AND starts_with(
      "storage_key",
      'hospitals/' || "hospital_id"::text || '/patients/' || "patient_id"::text
        || '/imports/' || "batch_id"::text || '/files/'
    )
  );

ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_scan_consistent
  CHECK (
    ("scan_status" = 'pending') = ("scanned_at" IS NULL)
    AND ("scan_status" = 'infected') = ("scan_signature" IS NOT NULL)
  );
-- Pages are cut only from a clean file.
ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_pages_after_clean
  CHECK ("pages_created_at" IS NULL OR "scan_status" = 'clean');
-- Only an upload never confirmed is abandoned.
ALTER TABLE "import_file"
  ADD CONSTRAINT import_file_abandoned_unconfirmed
  CHECK ("abandoned_at" IS NULL OR "upload_confirmed_at" IS NULL);

ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_number_from_one CHECK ("page_number" >= 1);
ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_mime_type_allowed
  CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'));
ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_size_bounded CHECK ("size_bytes" BETWEEN 1 AND 26214400);
ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_sha256_hex CHECK ("sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_storage_key_names_record
  CHECK (
    "storage_key" ~ '^hospitals/[0-9a-f-]{36}/patients/[0-9a-f-]{36}/imports/[0-9a-f-]{36}/pages/[0-9a-f-]{36}$'
    AND starts_with(
      "storage_key",
      'hospitals/' || "hospital_id"::text || '/patients/' || "patient_id"::text
        || '/imports/' || "batch_id"::text || '/pages/'
    )
  );

-- Classified with who and when; excluded with who, when and why.
ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_classified_consistent
  CHECK (
    ("document_id" IS NULL) = ("classified_at" IS NULL)
    AND ("document_id" IS NULL) = ("classified_by_staff_id" IS NULL)
  );
ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_excluded_consistent
  CHECK (
    ("excluded_at" IS NULL) = ("excluded_by_staff_id" IS NULL)
    AND ("excluded_at" IS NULL) = ("excluded_reason" IS NULL)
    AND ("excluded_reason" IS NULL OR length(btrim("excluded_reason")) > 0)
  );
ALTER TABLE "import_page"
  ADD CONSTRAINT import_page_classified_or_excluded
  CHECK (NOT ("document_id" IS NOT NULL AND "excluded_at" IS NOT NULL));

--------------------------------------------------------------------------------
-- 2. What a finished batch and an unscanned file refuse
--------------------------------------------------------------------------------

-- A finished batch takes no more files, and its pages are settled. Read under
-- the caller's row-level security: another hospital's batch is invisible here
-- and refused by the same-record foreign keys instead.
CREATE OR REPLACE FUNCTION app.check_import_batch_open() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  batch_status text;
BEGIN
  SELECT status::text INTO batch_status FROM "import_batch" WHERE id = NEW."batch_id";

  IF batch_status = 'done' THEN
    RAISE EXCEPTION 'import batch % is finished: nothing more is added or classified', NEW."batch_id"
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_TABLE_NAME || '_batch_open';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER import_file_batch_open
  BEFORE INSERT ON "import_file"
  FOR EACH ROW EXECUTE FUNCTION app.check_import_batch_open();

CREATE TRIGGER import_page_batch_open
  BEFORE INSERT OR UPDATE ON "import_page"
  FOR EACH ROW EXECUTE FUNCTION app.check_import_batch_open();

-- A page is cut only from a file that scanned clean.
CREATE OR REPLACE FUNCTION app.check_import_page_source() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  source_status text;
BEGIN
  SELECT scan_status::text INTO source_status FROM "import_file" WHERE id = NEW."file_id";

  IF source_status IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION 'a page is cut only from a file that scanned clean'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'import_page_file_clean';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER import_page_source
  BEFORE INSERT ON "import_page"
  FOR EACH ROW EXECUTE FUNCTION app.check_import_page_source();

--------------------------------------------------------------------------------
-- 3. Who may classify
--------------------------------------------------------------------------------

-- The same roles that record documents; the hospital admin never handles records.
CREATE TRIGGER import_page_classified_by_staff
  BEFORE UPDATE OF "classified_by_staff_id" ON "import_page"
  FOR EACH ROW
  WHEN (NEW."classified_by_staff_id" IS NOT NULL)
  EXECUTE FUNCTION app.check_document_staff('classified_by_staff_id', 'classified_by_staff');

CREATE TRIGGER import_page_excluded_by_staff
  BEFORE UPDATE OF "excluded_by_staff_id" ON "import_page"
  FOR EACH ROW
  WHEN (NEW."excluded_by_staff_id" IS NOT NULL)
  EXECUTE FUNCTION app.check_document_staff('excluded_by_staff_id', 'excluded_by_staff');

--------------------------------------------------------------------------------
-- 4. Immutability
--------------------------------------------------------------------------------

CREATE TRIGGER import_file_guard
  BEFORE UPDATE OR DELETE ON "import_file"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'scan_status:pending>clean,pending>infected',
    'scanned_at', 'scan_signature', 'sha256', 'page_count', 'pages_created_at',
    'upload_confirmed_at', 'abandoned_at'
  );

CREATE TRIGGER import_page_guard
  BEFORE UPDATE OR DELETE ON "import_page"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'document_id', 'classified_at', 'classified_by_staff_id',
    'excluded_at', 'excluded_by_staff_id', 'excluded_reason'
  );

--------------------------------------------------------------------------------
-- 5. Row-level security: the hospital's own work in progress, never shared
--------------------------------------------------------------------------------

ALTER TABLE "import_file" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_file" FORCE ROW LEVEL SECURITY;
CREATE POLICY import_file_read ON "import_file"
  FOR SELECT USING (app.is_system() OR "hospital_id" = app.current_hospital_id());
CREATE POLICY import_file_insert ON "import_file"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "import_batch" b
         WHERE b."id" = "import_file"."batch_id"
           AND b."hospital_id" = app.current_hospital_id()
      )
    )
  );
CREATE POLICY import_file_update ON "import_file"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

ALTER TABLE "import_page" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_page" FORCE ROW LEVEL SECURITY;
CREATE POLICY import_page_read ON "import_page"
  FOR SELECT USING (app.is_system() OR "hospital_id" = app.current_hospital_id());
CREATE POLICY import_page_insert ON "import_page"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "import_file" f
         WHERE f."id" = "import_page"."file_id"
           AND f."hospital_id" = app.current_hospital_id()
      )
    )
  );
CREATE POLICY import_page_update ON "import_page"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

--------------------------------------------------------------------------------
-- 6. Grants
--------------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON "import_file", "import_page" FROM health24_app;

GRANT UPDATE (
  "scan_status", "scanned_at", "scan_signature", "sha256", "page_count", "pages_created_at",
  "upload_confirmed_at", "abandoned_at"
) ON "import_file" TO health24_app;

GRANT UPDATE (
  "document_id", "classified_at", "classified_by_staff_id",
  "excluded_at", "excluded_by_staff_id", "excluded_reason"
) ON "import_page" TO health24_app;
