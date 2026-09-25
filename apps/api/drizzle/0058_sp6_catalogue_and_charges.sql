CREATE TYPE "public"."catalogue_category" AS ENUM('consultation', 'laboratory', 'imaging', 'procedure', 'bed', 'pharmacy', 'consumable', 'other');--> statement-breakpoint
CREATE TYPE "public"."charge_source" AS ENUM('order', 'procedure', 'bed_day', 'manual');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('captured', 'voided', 'invoiced');--> statement-breakpoint
CREATE TABLE "service_catalogue_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "catalogue_category" NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"price_paise" bigint NOT NULL,
	"active_from" date NOT NULL,
	"active_to" date,
	"created_by_staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_catalogue_item_identity" UNIQUE("id","hospital_id"),
	CONSTRAINT "service_catalogue_item_price_period" UNIQUE("hospital_id","code","active_from")
);
--> statement-breakpoint
CREATE TABLE "charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"source" charge_source DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"note" text,
	"status" charge_status DEFAULT 'captured' NOT NULL,
	"captured_by_staff_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_staff_id" uuid,
	"voided_reason" text,
	"invoice_id" uuid,
	CONSTRAINT "charge_identity" UNIQUE("id","patient_id","hospital_id")
);
--> statement-breakpoint
ALTER TABLE "service_catalogue_item" ADD CONSTRAINT "service_catalogue_item_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalogue_item" ADD CONSTRAINT "service_catalogue_item_created_by_same_hospital_fk" FOREIGN KEY ("created_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_item_same_hospital_fk" FOREIGN KEY ("item_id","hospital_id") REFERENCES "public"."service_catalogue_item"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_captured_by_same_hospital_fk" FOREIGN KEY ("captured_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_catalogue_item_code_idx" ON "service_catalogue_item" USING btree ("hospital_id","code");--> statement-breakpoint
CREATE INDEX "charge_encounter_idx" ON "charge" USING btree ("encounter_id","captured_at");--> statement-breakpoint
CREATE INDEX "charge_invoice_idx" ON "charge" USING btree ("invoice_id");