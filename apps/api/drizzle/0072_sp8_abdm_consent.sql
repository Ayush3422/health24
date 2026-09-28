CREATE TYPE "public"."consent_source" AS ENUM('local', 'abdm');--> statement-breakpoint
ALTER TABLE "consent_artefact" ALTER COLUMN "grantee_hospital_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "grantee_abdm_hiu_id" text;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "grantee_abdm_hiu_name" text;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "hip_hospital_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "abdm_care_context_ids" uuid[];--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "source" "consent_source" DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "abdm_consent_id" text;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "abdm_unmapped_types" text[];--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_hip_hospital_id_hospital_id_fk" FOREIGN KEY ("hip_hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_abdm_consent_id_unique" UNIQUE("abdm_consent_id");