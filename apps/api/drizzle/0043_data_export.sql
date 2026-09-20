CREATE TABLE "data_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"requested_by_account_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pdf_key" text,
	"fhir_key" text,
	"entry_count" integer,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"failure_reason" text
);
--> statement-breakpoint
ALTER TABLE "data_export" ADD CONSTRAINT "data_export_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export" ADD CONSTRAINT "data_export_requested_by_account_id_patient_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "public"."patient_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_export_patient_idx" ON "data_export" USING btree ("patient_id","requested_at");