CREATE TABLE "emergency_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"fields" text[] NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_account_id" uuid,
	CONSTRAINT "emergency_card_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "emergency_card" ADD CONSTRAINT "emergency_card_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_card" ADD CONSTRAINT "emergency_card_created_by_account_id_patient_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."patient_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_card" ADD CONSTRAINT "emergency_card_revoked_by_account_id_patient_account_id_fk" FOREIGN KEY ("revoked_by_account_id") REFERENCES "public"."patient_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emergency_card_patient_idx" ON "emergency_card" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emergency_card_one_in_use" ON "emergency_card" USING btree ("patient_id") WHERE "revoked_at" IS NULL;