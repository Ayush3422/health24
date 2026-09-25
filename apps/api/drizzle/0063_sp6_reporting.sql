CREATE TYPE "public"."statutory_return_kind" AS ENUM('ayush_morbidity');--> statement-breakpoint
CREATE TABLE "daily_summary" (
	"hospital_id" uuid NOT NULL,
	"ist_date" date NOT NULL,
	"metric" text NOT NULL,
	"dimension" text DEFAULT 'all' NOT NULL,
	"value" bigint NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_summary_hospital_id_ist_date_metric_dimension_pk" PRIMARY KEY("hospital_id","ist_date","metric","dimension")
);
--> statement-breakpoint
CREATE TABLE "statutory_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"kind" "statutory_return_kind" NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"contents" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_staff_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by_staff_id" uuid,
	"reference" text,
	CONSTRAINT "statutory_return_identity" UNIQUE("id","hospital_id")
);
--> statement-breakpoint
ALTER TABLE "daily_summary" ADD CONSTRAINT "daily_summary_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_return" ADD CONSTRAINT "statutory_return_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_return" ADD CONSTRAINT "statutory_return_generated_by_same_hospital_fk" FOREIGN KEY ("generated_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_return" ADD CONSTRAINT "statutory_return_submitted_by_same_hospital_fk" FOREIGN KEY ("submitted_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_summary_metric_idx" ON "daily_summary" USING btree ("hospital_id","metric","ist_date");--> statement-breakpoint
CREATE INDEX "statutory_return_period_idx" ON "statutory_return" USING btree ("hospital_id","kind","period_from");