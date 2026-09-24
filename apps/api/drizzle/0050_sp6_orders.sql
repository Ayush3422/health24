CREATE TYPE "public"."service_request_category" AS ENUM('laboratory', 'imaging', 'procedure');--> statement-breakpoint
CREATE TYPE "public"."service_request_priority" AS ENUM('routine', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."service_request_status" AS ENUM('ordered', 'collected', 'in_progress', 'resulted', 'cancelled');--> statement-breakpoint
CREATE TABLE "service_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"category" "service_request_category" NOT NULL,
	"requested_display" text NOT NULL,
	"requested_code_system" text,
	"requested_code" text,
	"priority" "service_request_priority" DEFAULT 'routine' NOT NULL,
	"clinical_note" text,
	"ordered_by_staff_id" uuid NOT NULL,
	"recorded_by_staff_id" uuid NOT NULL,
	"entry_source" "entry_source" DEFAULT 'direct' NOT NULL,
	"ordered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "service_request_status" DEFAULT 'ordered' NOT NULL,
	"reference" text,
	"collected_at" timestamp with time zone,
	"collected_by_staff_id" uuid,
	"in_progress_at" timestamp with time zone,
	"in_progress_by_staff_id" uuid,
	"resulted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_staff_id" uuid,
	"cancelled_reason" text,
	CONSTRAINT "service_request_identity" UNIQUE("id","patient_id","hospital_id")
);
--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "service_request_id" uuid;--> statement-breakpoint
ALTER TABLE "document_reference" ADD COLUMN "service_request_id" uuid;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_ordered_by_same_hospital_fk" FOREIGN KEY ("ordered_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_request_patient_idx" ON "service_request" USING btree ("patient_id","ordered_at");--> statement-breakpoint
CREATE INDEX "service_request_worklist_idx" ON "service_request" USING btree ("hospital_id","status","ordered_at");