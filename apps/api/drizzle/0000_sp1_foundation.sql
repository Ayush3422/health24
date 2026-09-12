CREATE TYPE "public"."access_action" AS ENUM('read', 'search', 'create', 'update', 'delete', 'export', 'login', 'login_failed', 'logout');--> statement-breakpoint
CREATE TYPE "public"."access_outcome" AS ENUM('allowed', 'denied');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('staff', 'patient', 'system');--> statement-breakpoint
CREATE TYPE "public"."blood_group" AS ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."facility_type" AS ENUM('allopathic', 'ayush', 'integrated');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other', 'undisclosed');--> statement-breakpoint
CREATE TYPE "public"."hospital_status" AS ENUM('onboarding', 'active', 'suspended', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."match_method" AS ENUM('abha_exact', 'probabilistic', 'manual');--> statement-breakpoint
CREATE TYPE "public"."merge_candidate_status" AS ENUM('pending', 'merged', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."patient_status" AS ENUM('active', 'merged');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('platform_admin', 'hospital_admin', 'clinician', 'front_desk');--> statement-breakpoint
CREATE TYPE "public"."system_of_medicine" AS ENUM('ayurveda', 'siddha', 'unani', 'yoga_naturopathy', 'homeopathy', 'allopathy');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended', 'deactivated');--> statement-breakpoint
CREATE TABLE "hospital" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"facility_type" "facility_type" NOT NULL,
	"hfr_id" text,
	"contact_email" text NOT NULL,
	"contact_phone" text NOT NULL,
	"address" jsonb,
	"mrn_prefix" text NOT NULL,
	"mrn_sequence" integer DEFAULT 0 NOT NULL,
	"status" "hospital_status" DEFAULT 'onboarding' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hospital_hfr_id_unique" UNIQUE("hfr_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "session_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hospital_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text,
	"role" "staff_role" NOT NULL,
	"system_of_medicine" "system_of_medicine",
	"hpr_id" text,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"totp_secret_encrypted" text,
	"totp_enrolled_at" timestamp with time zone,
	"recovery_code_hashes" text[],
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "patient_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"password_hash" text,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_account_patient_id_unique" UNIQUE("patient_id"),
	CONSTRAINT "patient_account_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "patient_demographic_change" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"changed_by_staff_id" uuid NOT NULL,
	"hospital_id" uuid,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_hospital_link" (
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"mrn" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_hospital_link_patient_id_hospital_id_pk" PRIMARY KEY("patient_id","hospital_id"),
	CONSTRAINT "patient_hospital_link_mrn_unique" UNIQUE("hospital_id","mrn")
);
--> statement-breakpoint
CREATE TABLE "patient_merge_candidate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_a_id" uuid NOT NULL,
	"patient_b_id" uuid NOT NULL,
	"score" double precision NOT NULL,
	"method" "match_method" NOT NULL,
	"matched_on" text[] NOT NULL,
	"status" "merge_candidate_status" DEFAULT 'pending' NOT NULL,
	"detected_by_hospital_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_staff_id" uuid,
	"resolved_at" timestamp with time zone,
	"decision_reason" text,
	CONSTRAINT "patient_merge_candidate_pair_unique" UNIQUE("patient_a_id","patient_b_id")
);
--> statement-breakpoint
CREATE TABLE "patient_merge_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"surviving_patient_id" uuid NOT NULL,
	"merged_patient_id" uuid NOT NULL,
	"performed_by_staff_id" uuid NOT NULL,
	"performed_at_hospital_id" uuid,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by_staff_id" uuid,
	"revert_reason" text
);
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"gender" "gender" NOT NULL,
	"date_of_birth" date,
	"approximate_age_years" integer,
	"birth_year" integer,
	"phone" text,
	"abha_number" text,
	"abha_address" text,
	"blood_group" "blood_group",
	"address" jsonb,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"created_by_hospital_id" uuid NOT NULL,
	"status" "patient_status" DEFAULT 'active' NOT NULL,
	"merged_into_patient_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_abha_number_unique" UNIQUE("abha_number"),
	CONSTRAINT "patient_abha_address_unique" UNIQUE("abha_address")
);
--> statement-breakpoint
CREATE TABLE "access_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_label" text,
	"hospital_id" uuid,
	"patient_id" uuid,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"action" "access_action" NOT NULL,
	"outcome" "access_outcome" DEFAULT 'allowed' NOT NULL,
	"consent_artefact_id" uuid,
	"break_glass_reason" text,
	"request_id" text,
	"route" text,
	"ip_address" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_account" ADD CONSTRAINT "patient_account_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_demographic_change" ADD CONSTRAINT "patient_demographic_change_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_demographic_change" ADD CONSTRAINT "patient_demographic_change_changed_by_staff_id_staff_user_id_fk" FOREIGN KEY ("changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_demographic_change" ADD CONSTRAINT "patient_demographic_change_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_hospital_link" ADD CONSTRAINT "patient_hospital_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_hospital_link" ADD CONSTRAINT "patient_hospital_link_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_candidate" ADD CONSTRAINT "patient_merge_candidate_patient_a_id_patient_id_fk" FOREIGN KEY ("patient_a_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_candidate" ADD CONSTRAINT "patient_merge_candidate_patient_b_id_patient_id_fk" FOREIGN KEY ("patient_b_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_candidate" ADD CONSTRAINT "patient_merge_candidate_detected_by_hospital_id_hospital_id_fk" FOREIGN KEY ("detected_by_hospital_id") REFERENCES "public"."hospital"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_candidate" ADD CONSTRAINT "patient_merge_candidate_resolved_by_staff_id_staff_user_id_fk" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_surviving_patient_id_patient_id_fk" FOREIGN KEY ("surviving_patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_merged_patient_id_patient_id_fk" FOREIGN KEY ("merged_patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_performed_by_staff_id_staff_user_id_fk" FOREIGN KEY ("performed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_performed_at_hospital_id_hospital_id_fk" FOREIGN KEY ("performed_at_hospital_id") REFERENCES "public"."hospital"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_log" ADD CONSTRAINT "patient_merge_log_reverted_by_staff_id_staff_user_id_fk" FOREIGN KEY ("reverted_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_created_by_hospital_id_hospital_id_fk" FOREIGN KEY ("created_by_hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_staff_user_idx" ON "session" USING btree ("staff_user_id");--> statement-breakpoint
CREATE INDEX "staff_user_hospital_idx" ON "staff_user" USING btree ("hospital_id");--> statement-breakpoint
CREATE INDEX "patient_demographic_change_patient_idx" ON "patient_demographic_change" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "patient_hospital_link_hospital_idx" ON "patient_hospital_link" USING btree ("hospital_id");--> statement-breakpoint
CREATE INDEX "patient_merge_candidate_status_idx" ON "patient_merge_candidate" USING btree ("status");--> statement-breakpoint
CREATE INDEX "patient_phone_idx" ON "patient" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "patient_name_normalized_idx" ON "patient" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "patient_birth_year_idx" ON "patient" USING btree ("birth_year");--> statement-breakpoint
CREATE INDEX "access_log_patient_idx" ON "access_log" USING btree ("patient_id","at");--> statement-breakpoint
CREATE INDEX "access_log_actor_idx" ON "access_log" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "access_log_hospital_idx" ON "access_log" USING btree ("hospital_id","at");