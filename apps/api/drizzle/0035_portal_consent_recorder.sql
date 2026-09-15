ALTER TYPE "public"."consent_capture_method" ADD VALUE 'patient_portal';--> statement-breakpoint
ALTER TABLE "consent_artefact" ALTER COLUMN "recorded_by_staff_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "recorded_by_patient_account_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD COLUMN "revoked_by_patient_account_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_recorded_by_patient_account_id_patient_account_id_fk" FOREIGN KEY ("recorded_by_patient_account_id") REFERENCES "public"."patient_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_artefact" ADD CONSTRAINT "consent_artefact_revoked_by_patient_account_id_patient_account_id_fk" FOREIGN KEY ("revoked_by_patient_account_id") REFERENCES "public"."patient_account"("id") ON DELETE no action ON UPDATE no action;