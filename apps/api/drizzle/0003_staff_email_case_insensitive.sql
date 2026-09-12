-- Staff email addresses are case-insensitive at the database level.
--
-- The login schema lowercases the address before looking it up, so an account
-- stored with any capital letters is an account nobody can sign into. Today
-- every write path runs through that schema, so this cannot happen — but
-- "cannot happen because every caller remembers" is the kind of invariant that
-- holds until the first import script, admin tool or data fix bypasses it.
--
-- Two accounts differing only by case would be worse than merely unreachable:
-- the unique constraint on `email` would permit both, and which one a future
-- lookup found would depend on the query. For staff accounts in a clinical
-- system, that ambiguity is not acceptable.
--
-- Found by an integration test whose fixture inserted a mixed-case address
-- directly and produced an account that could not log in.

-- Normalise anything already stored, so the index below can be created.
UPDATE "staff_user" SET "email" = lower("email") WHERE "email" <> lower("email");

CREATE UNIQUE INDEX IF NOT EXISTS "staff_user_email_lower_idx"
  ON "staff_user" (lower("email"));

-- The same reasoning applies to ABHA addresses, which are also lowercased by
-- their schema and also identify a person.
UPDATE "patient" SET "abha_address" = lower("abha_address")
 WHERE "abha_address" IS NOT NULL AND "abha_address" <> lower("abha_address");

CREATE UNIQUE INDEX IF NOT EXISTS "patient_abha_address_lower_idx"
  ON "patient" (lower("abha_address"))
  WHERE "abha_address" IS NOT NULL;
