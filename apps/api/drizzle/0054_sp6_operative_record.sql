CREATE TABLE "implant_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"procedure_id" uuid,
	"procedure_name" text,
	"name" text NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_or_lot" text,
	"implanted_at" timestamp with time zone NOT NULL,
	"notes" text,
	"recorded_by_staff_id" uuid NOT NULL,
	"attributed_clinician_id" uuid NOT NULL,
	"entry_source" "entry_source" DEFAULT 'direct' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "implant_device_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "implant_device_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
ALTER TABLE "procedure" ADD COLUMN "pre_op_assessment" text;--> statement-breakpoint
ALTER TABLE "procedure" ADD COLUMN "anaesthesia" text;--> statement-breakpoint
ALTER TABLE "procedure" ADD COLUMN "operative_note" text;--> statement-breakpoint
ALTER TABLE "procedure" ADD COLUMN "post_op_course" text;--> statement-breakpoint
ALTER TABLE "implant_device" ADD CONSTRAINT "implant_device_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "implant_device" ADD CONSTRAINT "implant_device_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "implant_device" ADD CONSTRAINT "implant_device_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "implant_device" ADD CONSTRAINT "implant_device_procedure_same_record_fk" FOREIGN KEY ("procedure_id","patient_id","hospital_id") REFERENCES "public"."procedure"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "implant_device" ADD CONSTRAINT "implant_device_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."implant_device"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "implant_device" ADD CONSTRAINT "implant_device_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "implant_device_patient_idx" ON "implant_device" USING btree ("patient_id","implanted_at");--> statement-breakpoint
CREATE INDEX "implant_device_serial_idx" ON "implant_device" USING btree ("hospital_id","serial_or_lot");