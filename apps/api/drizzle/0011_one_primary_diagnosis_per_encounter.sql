-- At most one current primary diagnosis per encounter.
--
-- An encounter's primary diagnosis is what a discharge summary, a claim and
-- the timeline lead with. Two would leave each of those guessing. Superseded
-- and entered-in-error versions are excluded, so a correction can replace the
-- primary diagnosis — provided it marks the original superseded before
-- inserting its replacement, since a unique index is checked immediately
-- rather than at commit.
CREATE UNIQUE INDEX IF NOT EXISTS condition_one_primary_per_encounter
  ON "condition" ("encounter_id")
  WHERE "is_primary" AND "version_status" = 'current';
