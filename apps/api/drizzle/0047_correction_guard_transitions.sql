-- SP5 Phase 8: a correction request goes from pending to applied or declined.
--
-- app.guard_clinical_row takes one argument per column, with the moves that
-- column may make listed after the colon. Two arguments for the same column
-- meant each refused what the other allowed, so neither move was possible.

DROP TRIGGER correction_request_guard ON "correction_request";

CREATE TRIGGER correction_request_guard
  BEFORE UPDATE OR DELETE ON "correction_request"
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_row(
    'status:pending>applied,pending>declined',
    'resolved_by_staff_id', 'resolved_at', 'resolution_note'
  );
