CREATE TYPE "public"."document_availability" AS ENUM('pending_scan', 'available', 'quarantined', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('lab_report', 'radiology', 'discharge_summary', 'prescription', 'operative_note', 'referral', 'bill_or_receipt', 'other');--> statement-breakpoint
CREATE TYPE "public"."file_scan_status" AS ENUM('pending', 'clean', 'infected');--> statement-breakpoint
CREATE TYPE "public"."import_batch_status" AS ENUM('open', 'classifying', 'done');--> statement-breakpoint
ALTER TYPE "public"."clinical_data_category" ADD VALUE 'documents';--> statement-breakpoint
CREATE TABLE "document_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text,
	"scan_status" "file_scan_status" DEFAULT 'pending' NOT NULL,
	"scanned_at" timestamp with time zone,
	"scan_signature" text,
	"page_count" integer,
	"thumbnail_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_file_position_once" UNIQUE("document_id","position")
);
--> statement-breakpoint
CREATE TABLE "document_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"encounter_id" uuid,
	"import_batch_id" uuid,
	"doc_type" "document_type" NOT NULL,
	"title" text,
	"report_date" date NOT NULL,
	"performing_facility" text,
	"ordering_clinician_id" uuid,
	"ordering_clinician_name" text,
	"availability" "document_availability" DEFAULT 'pending_scan' NOT NULL,
	"availability_changed_at" timestamp with time zone,
	"recorded_by_staff_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_status" "version_status" DEFAULT 'current' NOT NULL,
	"supersedes_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_staff_id" uuid,
	"status_reason" text,
	CONSTRAINT "document_reference_identity" UNIQUE("id","patient_id","hospital_id"),
	CONSTRAINT "document_reference_supersedes_once" UNIQUE("supersedes_id")
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"opened_by_staff_id" uuid NOT NULL,
	"status" "import_batch_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "import_batch_identity" UNIQUE("id","patient_id","hospital_id")
);
--> statement-breakpoint
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_document_same_record_fk" FOREIGN KEY ("document_id","patient_id","hospital_id") REFERENCES "public"."document_reference"("id","patient_id","hospital_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_encounter_same_record_fk" FOREIGN KEY ("encounter_id","patient_id","hospital_id") REFERENCES "public"."encounter"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_import_batch_same_record_fk" FOREIGN KEY ("import_batch_id","patient_id","hospital_id") REFERENCES "public"."import_batch"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_supersedes_same_record_fk" FOREIGN KEY ("supersedes_id","patient_id","hospital_id") REFERENCES "public"."document_reference"("id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_recorded_by_same_hospital_fk" FOREIGN KEY ("recorded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_ordering_clinician_same_hospital_fk" FOREIGN KEY ("ordering_clinician_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_status_changed_by_fk" FOREIGN KEY ("status_changed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_hospital_id_hospital_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospital"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_opened_by_same_hospital_fk" FOREIGN KEY ("opened_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_file_document_idx" ON "document_file" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_reference_patient_idx" ON "document_reference" USING btree ("patient_id","report_date");--> statement-breakpoint
CREATE INDEX "document_reference_hospital_idx" ON "document_reference" USING btree ("hospital_id","recorded_at");--> statement-breakpoint
CREATE INDEX "document_reference_import_batch_idx" ON "document_reference" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "import_batch_hospital_idx" ON "import_batch" USING btree ("hospital_id","status");