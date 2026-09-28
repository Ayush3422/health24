CREATE TYPE "public"."abdm_care_context_status" AS ENUM('linked', 'unlinked');--> statement-breakpoint
CREATE TYPE "public"."abdm_link_initiator" AS ENUM('hospital', 'patient');--> statement-breakpoint
CREATE TYPE "public"."abdm_link_request_status" AS ENUM('pending', 'confirmed', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "abdm_care_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"display" text NOT NULL,
	"initiated_by" "abdm_link_initiator" NOT NULL,
	"status" "abdm_care_context_status" DEFAULT 'linked' NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_by_staff_id" uuid,
	"unlinked_at" timestamp with time zone,
	"unlinked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_care_context_encounter_unique" UNIQUE("encounter_id")
);
--> statement-breakpoint
CREATE TABLE "abdm_link_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"abha_address" text NOT NULL,
	"initiated_by" "abdm_link_initiator" NOT NULL,
	"transaction_id" text,
	"encounter_ids" uuid[] NOT NULL,
	"code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" "abdm_link_request_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"requested_by_staff_id" uuid,
	"confirmed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "abdm_care_context" ADD CONSTRAINT "abdm_care_context_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_care_context" ADD CONSTRAINT "abdm_care_context_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_care_context" ADD CONSTRAINT "abdm_care_context_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_care_context" ADD CONSTRAINT "abdm_care_context_linked_by_staff_id_staff_user_id_fk" FOREIGN KEY ("linked_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_link_request" ADD CONSTRAINT "abdm_link_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_link_request" ADD CONSTRAINT "abdm_link_request_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_link_request" ADD CONSTRAINT "abdm_link_request_requested_by_staff_id_staff_user_id_fk" FOREIGN KEY ("requested_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abdm_care_context_patient_idx" ON "abdm_care_context" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "abdm_care_context_hospital_idx" ON "abdm_care_context" USING btree ("hospital_id","linked_at");--> statement-breakpoint
CREATE INDEX "abdm_link_request_patient_idx" ON "abdm_link_request" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "abdm_link_request_expiry_idx" ON "abdm_link_request" USING btree ("status","expires_at");