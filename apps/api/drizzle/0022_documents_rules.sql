-- SP4 Phase 2: documents under the clinical record's rules from SP3 —
-- consent, row-level security, integrity and immutability.
--
-- The previous migration added 'documents' to clinical_data_category. Postgres
-- refuses a newly added enum value inside the transaction that added it, so
-- the policy reaches it through app.consent_permits_category, which casts from
-- text when a query runs rather than when the policy is created.

--------------------------------------------------------------------------------
-- 1. Consent by category name
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.consent_permits_category(p_patient_id uuid, p_category text, p_on date)
  RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT app.consent_permits(p_patient_id, p_category::clinical_data_category, p_on) $$;

GRANT EXECUTE ON FUNCTION app.consent_permits_category(uuid, text, date) TO health24_app;

--------------------------------------------------------------------------------
-- 2. Integrity
--------------------------------------------------------------------------------

-- An ordering clinician is an account of this hospital, or, for a doctor
-- without one, a name. Never both.
ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_ordering_clinician_one
  CHECK (NOT ("ordering_clinician_id" IS NOT NULL AND "ordering_clinician_name" IS NOT NULL));
ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_ordering_name_present
  CHECK ("ordering_clinician_name" IS NULL OR length(btrim("ordering_clinician_name")) > 0);
ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_title_present
  CHECK ("title" IS NULL OR length(btrim("title")) > 0);
ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_report_date_plausible
  CHECK ("report_date" >= DATE '1900-01-01');

-- Availability changes once, from pending, and says when.
ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_availability_consistent
  CHECK (("availability" = 'pending_scan') = ("availability_changed_at" IS NULL));

ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_version_status_consistent
  CHECK (
    ("version_status" = 'current') = ("status_changed_at" IS NULL)
    AND ("version_status" = 'current'
         OR ("status_changed_by_staff_id" IS NOT NULL AND "status_reason" IS NOT NULL))
  );
ALTER TABLE "document_reference"
  ADD CONSTRAINT document_reference_not_self_superseding
  CHECK ("supersedes_id" IS NULL OR "supersedes_id" <> "id");

ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_position_from_one CHECK ("position" >= 1);
ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_mime_type_allowed
  CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'));
ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_size_bounded CHECK ("size_bytes" BETWEEN 1 AND 26214400);
ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_sha256_hex CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_page_count_positive CHECK ("page_count" IS NULL OR "page_count" >= 1);

-- A storage key is identifiers alone, and names this row's own hospital and
-- patient: no personal data in keys, and no file pointing into another record.
ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_storage_key_names_record
  CHECK (
    "storage_key" ~ '^hospitals/[0-9a-f-]{36}/patients/[0-9a-f-]{36}/documents/[0-9a-f-]{36}/[0-9a-f-]{36}$'
    AND starts_with(
      "storage_key",
      'hospitals/' || "hospital_id"::text || '/patients/' || "patient_id"::text || '/documents/'
    )
  );
ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_thumbnail_key_names_record
  CHECK (
    "thumbnail_key" IS NULL
    OR starts_with(
      "thumbnail_key",
      'hospitals/' || "hospital_id"::text || '/patients/' || "patient_id"::text || '/'
    )
  );

-- A scan is recorded with its time; an infected verdict with its signature.
ALTER TABLE "document_file"
  ADD CONSTRAINT document_file_scan_consistent
  CHECK (
    ("scan_status" = 'pending') = ("scanned_at" IS NULL)
    AND ("scan_status" = 'infected') = ("scan_signature" IS NOT NULL)
  );

ALTER TABLE "import_batch"
  ADD CONSTRAINT import_batch_closed_consistent
  CHECK (("status" = 'done') = ("closed_at" IS NOT NULL));
ALTER TABLE "import_batch"
  ADD CONSTRAINT import_batch_note_present
  CHECK ("note" IS NULL OR length(btrim("note")) > 0);

--------------------------------------------------------------------------------
-- 3. Who may record a document
--------------------------------------------------------------------------------

-- The front desk, records staff and clinicians upload (Decision H1); the
-- hospital admin never handles records. The ordering clinician, when an
-- account, is a clinician. Roles are read under the caller's row-level
-- security: staff of another hospital are invisible here and refused by the
-- same-hospital foreign keys instead.
CREATE OR REPLACE FUNCTION app.check_document_staff() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  recorder_role text;
  ordering_role text;
BEGIN
  SELECT role::text INTO recorder_role
    FROM "staff_user" WHERE id = (row_data ->> TG_ARGV[0])::uuid;

  IF recorder_role IS NOT NULL
     AND recorder_role NOT IN ('clinician', 'front_desk', 'medical_records')
  THEN
    RAISE EXCEPTION '% rows are recorded by the front desk, records staff or a clinician', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_TABLE_NAME || '_' || TG_ARGV[1];
  END IF;

  IF row_data ->> 'ordering_clinician_id' IS NOT NULL THEN
    SELECT role::text INTO ordering_role
      FROM "staff_user" WHERE id = (row_data ->> 'ordering_clinician_id')::uuid;

    IF ordering_role IS NOT NULL AND ordering_role <> 'clinician' THEN
      RAISE EXCEPTION 'the ordering clinician must be a clinician'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'document_reference_ordering_clinician_is_clinician';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER document_reference_staff
  BEFORE INSERT ON "document_reference"
  FOR EACH ROW EXECUTE FUNCTION app.check_document_staff('recorded_by_staff_id', 'recorded_by_staff');

CREATE TRIGGER import_batch_staff
  BEFORE INSERT ON "import_batch"
  FOR EACH ROW EXECUTE FUNCTION app.check_document_staff('opened_by_staff_id', 'opened_by_staff');

--------------------------------------------------------------------------------
-- 4. Immutability
--------------------------------------------------------------------------------

CREATE TRIGGER document_reference_guard
  BEFORE UPDATE OR DELETE ON "document_reference"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'availability:pending_scan>available,pending_scan>quarantined,pending_scan>abandoned',
    'availability_changed_at',
    'version_status:current>superseded,current>entered_in_error',
    'status_changed_at', 'status_changed_by_staff_id', 'status_reason'
  );

CREATE CONSTRAINT TRIGGER document_reference_supersession
  AFTER INSERT OR UPDATE ON "document_reference"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_supersession();

CREATE TRIGGER document_file_guard
  BEFORE UPDATE OR DELETE ON "document_file"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'scan_status:pending>clean,pending>infected',
    'scanned_at', 'scan_signature', 'sha256', 'page_count', 'thumbnail_key'
  );

CREATE TRIGGER import_batch_guard
  BEFORE UPDATE OR DELETE ON "import_batch"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:open>classifying,open>done,classifying>done', 'closed_at'
  );

--------------------------------------------------------------------------------
-- 5. Row-level security
--------------------------------------------------------------------------------

-- A document: its own hospital, or a hospital holding consent for documents on
-- its report date (Decision G1).
ALTER TABLE "document_reference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_reference" FORCE ROW LEVEL SECURITY;
CREATE POLICY document_reference_read ON "document_reference"
  FOR SELECT USING (
    app.is_system()
    OR "hospital_id" = app.current_hospital_id()
    OR app.consent_permits_category("patient_id", 'documents', "report_date")
  );
CREATE POLICY document_reference_insert ON "document_reference"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "document_reference"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );
CREATE POLICY document_reference_update ON "document_reference"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

-- A file is visible exactly when its document is: the subquery is itself
-- subject to the document's policy. Only the owning hospital adds or changes one.
ALTER TABLE "document_file" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_file" FORCE ROW LEVEL SECURITY;
CREATE POLICY document_file_read ON "document_file"
  FOR SELECT USING (
    app.is_system()
    OR EXISTS (SELECT 1 FROM "document_reference" d WHERE d."id" = "document_file"."document_id")
  );
CREATE POLICY document_file_insert ON "document_file"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "document_reference" d
         WHERE d."id" = "document_file"."document_id"
           AND d."hospital_id" = app.current_hospital_id()
      )
    )
  );
CREATE POLICY document_file_update ON "document_file"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

-- An import batch is the hospital's own work in progress: never shared.
ALTER TABLE "import_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batch" FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batch_read ON "import_batch"
  FOR SELECT USING (app.is_system() OR "hospital_id" = app.current_hospital_id());
CREATE POLICY import_batch_insert ON "import_batch"
  FOR INSERT WITH CHECK (
    app.is_system()
    OR (
      "hospital_id" = app.current_hospital_id()
      AND EXISTS (
        SELECT 1 FROM "patient_hospital_link" l
         WHERE l."patient_id" = "import_batch"."patient_id"
           AND l."hospital_id" = app.current_hospital_id()
      )
    )
  );
CREATE POLICY import_batch_update ON "import_batch"
  FOR UPDATE
  USING (app.is_system() OR "hospital_id" = app.current_hospital_id())
  WITH CHECK (app.is_system() OR "hospital_id" = app.current_hospital_id());

--------------------------------------------------------------------------------
-- 6. Application role
--------------------------------------------------------------------------------

-- No deletes. Updates only to lifecycle columns; the guards decide which moves
-- are legal, and these grants mean nothing else reaches them.
REVOKE UPDATE, DELETE, TRUNCATE ON "document_reference", "document_file", "import_batch"
  FROM health24_app;

GRANT UPDATE (
  "availability", "availability_changed_at",
  "version_status", "status_changed_at", "status_changed_by_staff_id", "status_reason"
) ON "document_reference" TO health24_app;

GRANT UPDATE ("scan_status", "scanned_at", "scan_signature", "sha256", "page_count", "thumbnail_key")
  ON "document_file" TO health24_app;

GRANT UPDATE ("status", "closed_at") ON "import_batch" TO health24_app;
