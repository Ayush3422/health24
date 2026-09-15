-- SP4 Phase 3: when an uploader confirmed that every file reached storage.
-- Until then a document may be abandoned and its objects removed; afterwards
-- it waits for its scan. Set once, like the other lifecycle times.

DROP TRIGGER document_reference_guard ON "document_reference";

CREATE TRIGGER document_reference_guard
  BEFORE UPDATE OR DELETE ON "document_reference"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'availability:pending_scan>available,pending_scan>quarantined,pending_scan>abandoned',
    'availability_changed_at',
    'upload_confirmed_at',
    'version_status:current>superseded,current>entered_in_error',
    'status_changed_at', 'status_changed_by_staff_id', 'status_reason'
  );

GRANT UPDATE ("upload_confirmed_at") ON "document_reference" TO health24_app;
