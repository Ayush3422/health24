CREATE TYPE "public"."allergy_category" AS ENUM('medication', 'food', 'environment', 'biologic');--> statement-breakpoint
CREATE TYPE "public"."allergy_clinical_status" AS ENUM('active', 'inactive', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."allergy_criticality" AS ENUM('low', 'high', 'unable_to_assess');--> statement-breakpoint
CREATE TYPE "public"."clinical_data_category" AS ENUM('encounters', 'diagnoses', 'medications', 'allergies', 'observations', 'notes', 'procedures');--> statement-breakpoint
CREATE TYPE "public"."coding_role" AS ENUM('primary', 'translated', 'advisory');--> statement-breakpoint
CREATE TYPE "public"."condition_clinical_status" AS ENUM('active', 'inactive', 'remission', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."condition_verification_status" AS ENUM('provisional', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."consent_capture_method" AS ENUM('signed_form', 'verbal_witnessed');--> statement-breakpoint
CREATE TYPE "public"."consent_purpose" AS ENUM('care_management');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."duration_unit" AS ENUM('days', 'weeks', 'months');--> statement-breakpoint
CREATE TYPE "public"."encounter_class" AS ENUM('outpatient', 'inpatient', 'emergency', 'teleconsultation');--> statement-breakpoint
CREATE TYPE "public"."encounter_status" AS ENUM('in_progress', 'finished', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."food_timing" AS ENUM('empty_stomach', 'before_food', 'with_food', 'after_food', 'bedtime', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."medication_request_status" AS ENUM('active', 'stopped', 'completed');--> statement-breakpoint
CREATE TYPE "public"."medication_route" AS ENUM('oral', 'sublingual', 'topical', 'nasal', 'ophthalmic', 'otic', 'inhalation', 'rectal', 'vaginal', 'intravenous', 'intramuscular', 'subcutaneous', 'other');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('current', 'superseded', 'entered_in_error');--> statement-breakpoint
CREATE TABLE "allergy_intolerance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid,
	"substance" text NOT NULL,
	"category" "allergy_category" NOT NULL,
	"criticality" "allergy_criticality" DEFAULT 'unable_to_assess' NOT NULL,
	"clinical_status" "allergy_clinical_status" DEFAULT 'active' NOT NULL,
	"reaction" text,
	"note" text,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "allergy_intolerance_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "allergy_intolerance_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
CREATE TABLE "clinical_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"template" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "clinical_note_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "clinical_note_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
CREATE TABLE "condition_coding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"condition_id" uuid NOT NULL,
	"role" "coding_role" NOT NULL,
	"code_system_key" text NOT NULL,
	"code_system_version" text NOT NULL,
	"code" text NOT NULL,
	"display" text NOT NULL,
	"equivalence" "map_equivalence",
	"confidence" double precision,
	"concept_map_element_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "condition_coding_one_per_role" UNIQUE("condition_id","role")
);
--> statement-breakpoint
CREATE TABLE "condition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"clinical_status" "condition_clinical_status" DEFAULT 'active' NOT NULL,
	"verification_status" "condition_verification_status" DEFAULT 'confirmed' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"onset_date" date,
	"note" text,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "condition_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "condition_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
CREATE TABLE "consent_artefact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"grantee_hospital_id" uuid NOT NULL,
	"purpose" "consent_purpose" DEFAULT 'care_management' NOT NULL,
	"data_categories" "clinical_data_category"[] NOT NULL,
	"date_range_from" date,
	"date_range_to" date,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"capture_method" "consent_capture_method" NOT NULL,
	"witness_name" text,
	"recorded_by_staff_id" uuid NOT NULL,
	"status" "consent_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_staff_id" uuid,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"class" "encounter_class" NOT NULL,
	"system_of_medicine" "system_of_medicine" NOT NULL,
	"attending_staff_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"chief_complaint" text,
	"status" "encounter_status" DEFAULT 'in_progress' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_identity" UNIQUE("id","patient_id","hospital_id")
);
--> statement-breakpoint
CREATE TABLE "medication_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"system_of_medicine" "system_of_medicine" NOT NULL,
	"medicine_name" text NOT NULL,
	"medicine_code_system" text,
	"medicine_code" text,
	"form" text,
	"strength" text,
	"dose_quantity" numeric(10, 3),
	"dose_unit" text,
	"frequency" text NOT NULL,
	"route" "medication_route" NOT NULL,
	"duration_value" integer,
	"duration_unit" "duration_unit",
	"start_date" date DEFAULT CURRENT_DATE NOT NULL,
	"vehicle" text,
	"food_timing" "food_timing",
	"instructions" text,
	"status" "medication_request_status" DEFAULT 'active' NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_staff_id" uuid,
	"end_reason" text,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "medication_request_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "medication_request_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
CREATE TABLE "observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid,
	"code_system" text NOT NULL,
	"code" text NOT NULL,
	"display" text NOT NULL,
	"value_quantity" numeric(12, 4),
	"value_text" text,
	"unit" text,
	"group_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "observation_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "observation_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
CREATE TABLE "patient_merge_alias" (
	"merged_patient_id" uuid NOT NULL,
	"surviving_patient_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_merge_alias_merged_patient_id_pk" PRIMARY KEY("merged_patient_id")
);
--> statement-breakpoint
CREATE TABLE "procedure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"system_of_medicine" "system_of_medicine" NOT NULL,
	"name" text NOT NULL,
	"code_system" text,
	"code" text,
	"performed_at" timestamp with time zone NOT NULL,
	"performer_staff_id" uuid NOT NULL,
	"outcome" text,
	"notes" text,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "procedure_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "procedure_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
-- Must precede the composite foreign keys below that reference it.
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_id_hospital_unique" UNIQUE("id","hospital_id");--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."allergy_intolerance"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_intolerance" ADD CONSTRAINT "allergy_intolerance_status_changed_by_fk" FOREIGN KEY ("status_changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."clinical_note"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_status_changed_by_fk" FOREIGN KEY ("status_changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition_coding" ADD CONSTRAINT "condition_coding_condition_id_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."condition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition_coding" ADD CONSTRAINT "condition_coding_concept_map_element_id_concept_map_element_id_fk" FOREIGN KEY ("concept_map_element_id") REFERENCES "public"."concept_map_element"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."condition"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_status_changed_by_fk" FOREIGN KEY ("status_changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_grantee_hospital_id_hospital_id_fk" FOREIGN KEY ("grantee_hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_revoked_by_staff_id_staff_user_id_fk" FOREIGN KEY ("revoked_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_recorded_by_grantee_staff_fk" FOREIGN KEY ("recorded_by_staff_id","grantee_hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_attending_staff_same_hospital_fk" FOREIGN KEY ("attending_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."medication_request"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_status_changed_by_fk" FOREIGN KEY ("status_changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_request" ADD CONSTRAINT "medication_request_ended_by_fk" FOREIGN KEY ("ended_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."observation"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_status_changed_by_fk" FOREIGN KEY ("status_changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_alias" ADD CONSTRAINT "patient_merge_alias_merged_patient_id_patient_id_fk" FOREIGN KEY ("merged_patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_alias" ADD CONSTRAINT "patient_merge_alias_surviving_patient_id_patient_id_fk" FOREIGN KEY ("surviving_patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."procedure"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_performer_same_hospital_fk" FOREIGN KEY ("performer_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_status_changed_by_fk" FOREIGN KEY ("status_changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allergy_intolerance_patient_idx" ON "allergy_intolerance" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "clinical_note_patient_idx" ON "clinical_note" USING btree ("patient_id","recorded_at");--> statement-breakpoint
CREATE INDEX "clinical_note_encounter_idx" ON "clinical_note" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "condition_coding_code_idx" ON "condition_coding" USING btree ("code_system_key","code");--> statement-breakpoint
CREATE INDEX "condition_coding_map_element_idx" ON "condition_coding" USING btree ("concept_map_element_id");--> statement-breakpoint
CREATE INDEX "condition_patient_idx" ON "condition" USING btree ("patient_id","recorded_at");--> statement-breakpoint
CREATE INDEX "condition_encounter_idx" ON "condition" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "consent_artefact_patient_grantee_idx" ON "consent_artefact" USING btree ("patient_id","grantee_hospital_id");--> statement-breakpoint
CREATE INDEX "encounter_patient_started_idx" ON "encounter" USING btree ("patient_id","started_at");--> statement-breakpoint
CREATE INDEX "encounter_hospital_started_idx" ON "encounter" USING btree ("hospital_id","started_at");--> statement-breakpoint
CREATE INDEX "medication_request_patient_idx" ON "medication_request" USING btree ("patient_id","start_date");--> statement-breakpoint
CREATE INDEX "medication_request_encounter_idx" ON "medication_request" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "observation_patient_effective_idx" ON "observation" USING btree ("patient_id","effective_at");--> statement-breakpoint
CREATE INDEX "observation_patient_code_idx" ON "observation" USING btree ("patient_id","code");--> statement-breakpoint
CREATE INDEX "patient_merge_alias_surviving_idx" ON "patient_merge_alias" USING btree ("surviving_patient_id");--> statement-breakpoint
CREATE INDEX "procedure_patient_performed_idx" ON "procedure" USING btree ("patient_id","performed_at");
