CREATE TYPE "public"."bed_status" AS ENUM('available', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."ward_kind" AS ENUM('general', 'icu', 'private', 'day_care');--> statement-breakpoint
CREATE TYPE "public"."ward_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TABLE "bed_stay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"bed_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"moved_reason" text,
	"started_by_staff_id" uuid NOT NULL,
	"ended_by_staff_id" uuid
);
--> statement-breakpoint
CREATE TABLE "bed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"ward_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" "bed_status" DEFAULT 'available' NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bed_identity" UNIQUE("id","hospital_id"),
	CONSTRAINT "bed_label_per_ward" UNIQUE("ward_id","label")
);
--> statement-breakpoint
CREATE TABLE "ward" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "ward_kind" NOT NULL,
	"status" "ward_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ward_identity" UNIQUE("id","hospital_id"),
	CONSTRAINT "ward_name_per_hospital" UNIQUE("hospital_id","name")
);
--> statement-breakpoint
ALTER TABLE "bed_stay" ADD CONSTRAINT "bed_stay_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stay" ADD CONSTRAINT "bed_stay_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stay" ADD CONSTRAINT "bed_stay_bed_same_hospital_fk" FOREIGN KEY ("bed_id","hospital_id") REFERENCES "public"."bed"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stay" ADD CONSTRAINT "bed_stay_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stay" ADD CONSTRAINT "bed_stay_started_by_same_hospital_fk" FOREIGN KEY ("started_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed" ADD CONSTRAINT "bed_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed" ADD CONSTRAINT "bed_ward_same_hospital_fk" FOREIGN KEY ("ward_id","hospital_id") REFERENCES "public"."ward"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ward" ADD CONSTRAINT "ward_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bed_stay_encounter_idx" ON "bed_stay" USING btree ("encounter_id","started_at");--> statement-breakpoint
CREATE INDEX "bed_stay_bed_idx" ON "bed_stay" USING btree ("bed_id","started_at");