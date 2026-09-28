CREATE TYPE "public"."abdm_transfer_status" AS ENUM('pending', 'transferred', 'partly_transferred', 'failed', 'refused');--> statement-breakpoint
CREATE TABLE "abdm_data_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consent_artefact_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"abdm_transaction_id" text NOT NULL,
	"data_push_url" text NOT NULL,
	"requester_public_key" text NOT NULL,
	"requester_nonce" text NOT NULL,
	"status" "abdm_transfer_status" DEFAULT 'pending' NOT NULL,
	"care_contexts_requested" integer NOT NULL,
	"care_contexts_sent" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "abdm_data_request_abdm_transaction_id_unique" UNIQUE("abdm_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "abdm_data_request" ADD CONSTRAINT "abdm_data_request_consent_artefact_id_consent_artefact_id_fk" FOREIGN KEY ("consent_artefact_id") REFERENCES "public"."consent_artefact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_data_request" ADD CONSTRAINT "abdm_data_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_data_request" ADD CONSTRAINT "abdm_data_request_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abdm_data_request_patient_idx" ON "abdm_data_request" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "abdm_data_request_status_idx" ON "abdm_data_request" USING btree ("status","created_at");