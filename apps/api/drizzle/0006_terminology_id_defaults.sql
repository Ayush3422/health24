-- Terminology primary keys get a database-level default.
--
-- The same defect migration 0002 fixed for the SP1 tables, repeated here and
-- caught on the way to writing a probe: Drizzle's $defaultFn generates UUIDv7
-- in the application only. Any writer that is not Drizzle — a psql session, a
-- converter script for a real NAMASTE file, a restore — inserts a null id.
-- gen_random_uuid() is the floor; application writes still supply v7.

ALTER TABLE "code_system"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "concept"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "concept_designation"  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "concept_map"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "concept_map_element"  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "concept_map_review"   ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
