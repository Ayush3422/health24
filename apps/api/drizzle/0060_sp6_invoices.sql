CREATE TYPE "public"."insurance_scheme" AS ENUM('pmjay', 'state_scheme', 'private', 'employer');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('payment', 'refund', 'credit_note');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'upi', 'card', 'bank_transfer', 'scheme');--> statement-breakpoint
CREATE TABLE "invoice_insurance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"scheme" "insurance_scheme" NOT NULL,
	"insurer" text,
	"policy_or_card" text,
	"approved_paise" bigint,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	CONSTRAINT "invoice_line_charge_once" UNIQUE("charge_id")
);
--> statement-breakpoint
CREATE TABLE "invoice_number_series" (
	"hospital_id" uuid NOT NULL,
	"financial_year" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoice_number_series_hospital_id_financial_year_pk" PRIMARY KEY("hospital_id","financial_year")
);
--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"number" text NOT NULL,
	"financial_year" text NOT NULL,
	"total_paise" bigint NOT NULL,
	"note" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by_staff_id" uuid NOT NULL,
	"document_reference_id" uuid,
	CONSTRAINT "invoice_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "invoice_hospital_identity" UNIQUE("id","hospital_id"),
	CONSTRAINT "invoice_number_once" UNIQUE("hospital_id","number")
);
--> statement-breakpoint
CREATE TABLE "payment_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"method" "payment_method",
	"amount_paise" bigint NOT NULL,
	"reference" text,
	"note" text,
	"taken_by_staff_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_insurance" ADD CONSTRAINT "invoice_insurance_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_insurance" ADD CONSTRAINT "invoice_insurance_invoice_same_hospital_fk" FOREIGN KEY ("invoice_id","hospital_id") REFERENCES "public"."invoice"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_same_hospital_fk" FOREIGN KEY ("invoice_id","hospital_id") REFERENCES "public"."invoice"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_number_series" ADD CONSTRAINT "invoice_number_series_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issued_by_same_hospital_fk" FOREIGN KEY ("issued_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_entry" ADD CONSTRAINT "payment_entry_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_entry" ADD CONSTRAINT "payment_entry_invoice_same_hospital_fk" FOREIGN KEY ("invoice_id","hospital_id") REFERENCES "public"."invoice"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_entry" ADD CONSTRAINT "payment_entry_taken_by_same_hospital_fk" FOREIGN KEY ("taken_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_insurance_invoice_idx" ON "invoice_insurance" USING btree ("invoice_id","recorded_at");--> statement-breakpoint
CREATE INDEX "invoice_line_invoice_idx" ON "invoice_line" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_patient_idx" ON "invoice" USING btree ("patient_id","issued_at");--> statement-breakpoint
CREATE INDEX "invoice_hospital_idx" ON "invoice" USING btree ("hospital_id","issued_at");--> statement-breakpoint
CREATE INDEX "payment_entry_invoice_idx" ON "payment_entry" USING btree ("invoice_id","at");