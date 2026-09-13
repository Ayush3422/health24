-- The hospital directory: facility names readable by every tenant, so a
-- shared clinical entry can say where it was recorded.
--
-- `hospital` stays tenant-scoped. This copy holds only the name and facility
-- type — public information, published by the ABDM facility registry — and
-- is written by a trigger alone. The application reads it and nothing more.

-- Backfill. System context, because `hospital` forces row-level security even
-- on its owner.
SELECT set_config('app.system_context', 'on', true);

INSERT INTO "hospital_directory" ("id", "name", "facility_type")
SELECT "id", "name", "facility_type" FROM "hospital"
ON CONFLICT ("id") DO NOTHING;

-- Security definer, so the copy is written with the owner's rights whatever
-- role changed the hospital. The directory does not force row-level security,
-- so the owner writes it; the application role has no write grant at all.
CREATE OR REPLACE FUNCTION app.sync_hospital_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  INSERT INTO "hospital_directory" ("id", "name", "facility_type", "updated_at")
  VALUES (NEW."id", NEW."name", NEW."facility_type", now())
  ON CONFLICT ("id") DO UPDATE
    SET "name" = EXCLUDED."name",
        "facility_type" = EXCLUDED."facility_type",
        "updated_at" = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER hospital_directory_sync
  AFTER INSERT OR UPDATE OF "name", "facility_type" ON "hospital"
  FOR EACH ROW EXECUTE FUNCTION app.sync_hospital_directory();

ALTER TABLE "hospital_directory" ENABLE ROW LEVEL SECURITY;
CREATE POLICY hospital_directory_read ON "hospital_directory"
  FOR SELECT USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "hospital_directory" FROM health24_app;
