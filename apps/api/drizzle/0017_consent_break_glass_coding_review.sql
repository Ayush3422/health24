CREATE TYPE "public"."break_glass_review_outcome" AS ENUM('justified', 'unjustified');--> statement-breakpoint
ALTER TYPE "public"."consent_capture_method" ADD VALUE 'break_glass';--> statement-breakpoint
CREATE TABLE "coding_review_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"condition_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"concept_map_element_id" uuid NOT NULL,
	"note" text NOT NULL,
	"acknowledged_by_staff_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_review_acknowledgement_once" UNIQUE("condition_id","concept_map_element_id")
);
--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "emergency_reason" text;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "reviewed_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "review_outcome" "break_glass_review_outcome";--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "patient_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coding_review_acknowledgement" ADD CONSTRAINT "coding_review_acknowledgement_condition_id_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."condition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_review_acknowledgement" ADD CONSTRAINT "coding_review_acknowledgement_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_review_acknowledgement" ADD CONSTRAINT "coding_review_acknowledgement_concept_map_element_id_concept_map_element_id_fk" FOREIGN KEY ("concept_map_element_id") REFERENCES "public"."concept_map_element"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_review_acknowledgement" ADD CONSTRAINT "coding_review_acknowledgement_by_same_hospital_fk" FOREIGN KEY ("acknowledged_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coding_review_acknowledgement_hospital_idx" ON "coding_review_acknowledgement" USING btree ("hospital_id");--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_reviewed_by_staff_id_staff_user_id_fk" FOREIGN KEY ("reviewed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;