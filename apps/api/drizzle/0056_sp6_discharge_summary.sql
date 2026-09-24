CREATE TYPE "public"."discharge_status" AS ENUM('draft', 'signed');--> statement-breakpoint
CREATE TABLE "discharge_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"status" "discharge_status" DEFAULT 'draft' NOT NULL,
	"sections" jsonb NOT NULL,
	"composed_from" jsonb NOT NULL,
	"composed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"composed_by_staff_id" uuid NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by_staff_id" uuid,
	"clinical_note_id" uuid,
	"document_reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discharge_summary_once_per_encounter" UNIQUE("encounter_id")
);
--> statement-breakpoint
ALTER TABLE "discharge_summary" ADD CONSTRAINT "discharge_summary_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discharge_summary" ADD CONSTRAINT "discharge_summary_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discharge_summary" ADD CONSTRAINT "discharge_summary_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discharge_summary" ADD CONSTRAINT "discharge_summary_composed_by_same_hospital_fk" FOREIGN KEY ("composed_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discharge_summary" ADD CONSTRAINT "discharge_summary_signed_by_same_hospital_fk" FOREIGN KEY ("signed_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discharge_summary_patient_idx" ON "discharge_summary" USING btree ("patient_id","composed_at");