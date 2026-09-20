CREATE TABLE "correction_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"requested_by_account_id" uuid NOT NULL,
	"field" text NOT NULL,
	"current_value" text,
	"requested_value" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_staff_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text
);
--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_requested_by_account_id_patient_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "public"."patient_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_resolved_by_same_hospital_fk" FOREIGN KEY ("resolved_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correction_request_hospital_idx" ON "correction_request" USING btree ("hospital_id","status");--> statement-breakpoint
CREATE INDEX "correction_request_patient_idx" ON "correction_request" USING btree ("patient_id","created_at");