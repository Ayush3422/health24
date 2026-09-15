ALTER TABLE "otp_challenge" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "patient_portal_access" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "patient_session" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();