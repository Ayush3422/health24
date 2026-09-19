ALTER TABLE "patient_portal_access" ADD COLUMN "guardian_name" text;--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD COLUMN "guardian_relation" text;--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD COLUMN "guardian_document" text;--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD COLUMN "handed_over_at" timestamp with time zone;