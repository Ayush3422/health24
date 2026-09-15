CREATE TYPE "public"."portal_relationship" AS ENUM('self', 'guardian');--> statement-breakpoint
CREATE TABLE "otp_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_portal_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"relationship" "portal_relationship" DEFAULT 'self' NOT NULL,
	"activated_at_hospital_id" uuid NOT NULL,
	"activated_by_staff_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_staff_id" uuid,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "patient_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "patient_session_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
ALTER TABLE "patient_account" DROP CONSTRAINT "patient_account_patient_id_unique";--> statement-breakpoint
ALTER TABLE "patient_account" DROP CONSTRAINT "patient_account_patient_id_patient_id_fk";
--> statement-breakpoint
ALTER TABLE "patient_account" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD CONSTRAINT "patient_portal_access_account_id_patient_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."patient_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD CONSTRAINT "patient_portal_access_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD CONSTRAINT "patient_portal_access_activated_at_hospital_id_hospital_id_fk" FOREIGN KEY ("activated_at_hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD CONSTRAINT "patient_portal_access_activated_by_same_hospital_fk" FOREIGN KEY ("activated_by_staff_id","activated_at_hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_portal_access" ADD CONSTRAINT "patient_portal_access_revoked_by_fk" FOREIGN KEY ("revoked_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_session" ADD CONSTRAINT "patient_session_account_id_patient_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."patient_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_session" ADD CONSTRAINT "patient_session_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otp_challenge_phone_idx" ON "otp_challenge" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "patient_portal_access_account_idx" ON "patient_portal_access" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "patient_portal_access_patient_idx" ON "patient_portal_access" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_portal_access_active_once" ON "patient_portal_access" USING btree ("account_id","patient_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "patient_session_account_idx" ON "patient_session" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "patient_account" DROP COLUMN "patient_id";--> statement-breakpoint
ALTER TABLE "patient_account" DROP COLUMN "password_hash";