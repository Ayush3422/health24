-- SP5 Phase 4: a consent the patient granted has no staff recorder, and a
-- review never applies to it.
--
-- `reviewed_by_staff_id IS DISTINCT FROM recorded_by_staff_id` is false when
-- both are null, which refused every portal consent. The rule it states — a
-- reviewer is never the person who took emergency access — only concerns a
-- reviewed row.

ALTER TABLE "consent_artefact" DROP CONSTRAINT consent_artefact_review_consistent;

ALTER TABLE "consent_artefact"
  ADD CONSTRAINT consent_artefact_review_consistent
  CHECK (
    ("reviewed_at" IS NULL) = ("reviewed_by_staff_id" IS NULL)
    AND ("reviewed_at" IS NULL) = ("review_outcome" IS NULL)
    AND ("reviewed_at" IS NULL) = ("review_note" IS NULL)
    AND ("reviewed_at" IS NULL OR "capture_method"::text = 'break_glass')
    AND ("reviewed_at" IS NULL OR "reviewed_by_staff_id" IS DISTINCT FROM "recorded_by_staff_id")
  );
