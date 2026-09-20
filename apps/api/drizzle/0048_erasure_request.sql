ALTER TYPE "public"."staff_role" ADD VALUE 'data_protection_officer';--> statement-breakpoint
CREATE TABLE "erasure_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"requested_by_account_id" uuid NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_staff_id" uuid,
	"decided_at" timestamp with time zone,
	"outcome" text,
	"retention_note" text,
	"erased_summary" text
);
--> statement-breakpoint
ALTER TABLE "erasure_request" ADD CONSTRAINT "erasure_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_request" ADD CONSTRAINT "erasure_request_requested_by_account_id_patient_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "public"."patient_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_request" ADD CONSTRAINT "erasure_request_decided_by_staff_id_staff_user_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasure_request_status_idx" ON "erasure_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "erasure_request_patient_idx" ON "erasure_request" USING btree ("patient_id","created_at");