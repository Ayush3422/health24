CREATE TYPE "public"."abha_verification_method" AS ENUM('mobile_otp', 'aadhaar_otp');--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "abha_number_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "abha_address_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "abha_verification_method" "abha_verification_method";--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "abha_verified_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_abha_verified_by_staff_id_staff_user_id_fk" FOREIGN KEY ("abha_verified_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;