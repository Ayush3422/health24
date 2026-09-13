CREATE TYPE "public"."entry_source" AS ENUM('direct', 'transcribed');--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'medical_records';--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD COLUMN "attributed_clinician_id" uuid;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD COLUMN "entry_source" "entry_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "attributed_clinician_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD COLUMN "entry_source" "entry_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "condition" ADD COLUMN "attributed_clinician_id" uuid;--> statement-breakpoint
ALTER TABLE "condition" ADD COLUMN "entry_source" "entry_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "recorded_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "entry_source" "entry_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_request" ADD COLUMN "attributed_clinician_id" uuid;--> statement-breakpoint
ALTER TABLE "medication_request" ADD COLUMN "entry_source" "entry_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "attributed_clinician_id" uuid;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "entry_source" "entry_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure" ADD COLUMN "attributed_clinician_id" uuid;--> statement-breakpoint
ALTER TABLE "procedure" ADD COLUMN "entry_source" "entry_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_attributed_clinician_same_hospital_fk" FOREIGN KEY ("attributed_clinician_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_attributed_clinician_same_hospital_fk" FOREIGN KEY ("attributed_clinician_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_attributed_clinician_same_hospital_fk" FOREIGN KEY ("attributed_clinician_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_attributed_clinician_same_hospital_fk" FOREIGN KEY ("attributed_clinician_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_attributed_clinician_same_hospital_fk" FOREIGN KEY ("attributed_clinician_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_attributed_clinician_same_hospital_fk" FOREIGN KEY ("attributed_clinician_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Backfill. Every existing entry was made directly by the clinician it names,
-- so the recorder is the attributed clinician, and an encounter was opened by
-- its attending clinician. Row triggers are disabled for the update only: the
-- immutability guards (0008) would rightly refuse it from anyone but a
-- migration. System context, because these tables force row-level security.
SELECT set_config('app.system_context', 'on', true);--> statement-breakpoint
ALTER TABLE "encounter" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "encounter" SET "recorded_by_staff_id" = "attending_staff_id" WHERE "recorded_by_staff_id" IS NULL;--> statement-breakpoint
ALTER TABLE "encounter" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "encounter" ALTER COLUMN "recorded_by_staff_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "allergy_intolerance" SET "attributed_clinician_id" = "recorded_by_staff_id" WHERE "attributed_clinician_id" IS NULL;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ALTER COLUMN "attributed_clinician_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_note" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "clinical_note" SET "attributed_clinician_id" = "recorded_by_staff_id" WHERE "attributed_clinician_id" IS NULL;--> statement-breakpoint
ALTER TABLE "clinical_note" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "clinical_note" ALTER COLUMN "attributed_clinician_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "condition" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "condition" SET "attributed_clinician_id" = "recorded_by_staff_id" WHERE "attributed_clinician_id" IS NULL;--> statement-breakpoint
ALTER TABLE "condition" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "condition" ALTER COLUMN "attributed_clinician_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_request" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "medication_request" SET "attributed_clinician_id" = "recorded_by_staff_id" WHERE "attributed_clinician_id" IS NULL;--> statement-breakpoint
ALTER TABLE "medication_request" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "medication_request" ALTER COLUMN "attributed_clinician_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "observation" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "observation" SET "attributed_clinician_id" = "recorded_by_staff_id" WHERE "attributed_clinician_id" IS NULL;--> statement-breakpoint
ALTER TABLE "observation" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "observation" ALTER COLUMN "attributed_clinician_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "procedure" SET "attributed_clinician_id" = "recorded_by_staff_id" WHERE "attributed_clinician_id" IS NULL;--> statement-breakpoint
ALTER TABLE "procedure" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "procedure" ALTER COLUMN "attributed_clinician_id" SET NOT NULL;
