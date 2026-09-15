CREATE TYPE "public"."observation_category" AS ENUM('vital_signs', 'laboratory');--> statement-breakpoint
CREATE TYPE "public"."observation_source" AS ENUM('entered', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."result_interpretation" AS ENUM('normal', 'low', 'high', 'abnormal');--> statement-breakpoint
ALTER TABLE "observation" ALTER COLUMN "attributed_clinician_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "category" "observation_category" DEFAULT 'vital_signs' NOT NULL;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "source" "observation_source" DEFAULT 'entered' NOT NULL;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "panel_code" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "reference_low" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "reference_high" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "reference_text" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "interpretation" "result_interpretation";--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "lab_flag" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "value_canonical" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "unit_canonical" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "performing_facility" text;