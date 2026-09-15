CREATE TABLE "import_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text,
	"upload_confirmed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"scan_status" "file_scan_status" DEFAULT 'pending' NOT NULL,
	"scanned_at" timestamp with time zone,
	"scan_signature" text,
	"page_count" integer,
	"pages_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_file_position_once" UNIQUE("batch_id","position"),
	CONSTRAINT "import_file_storage_key_once" UNIQUE("storage_key"),
	CONSTRAINT "import_file_identity" UNIQUE("id","batch_id","patient_id","hospital_id")
);--> statement-breakpoint
CREATE TABLE "import_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"document_id" uuid,
	"classified_at" timestamp with time zone,
	"classified_by_staff_id" uuid,
	"excluded_at" timestamp with time zone,
	"excluded_by_staff_id" uuid,
	"excluded_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_page_number_once" UNIQUE("file_id","page_number"),
	CONSTRAINT "import_page_storage_key_once" UNIQUE("storage_key")
);--> statement-breakpoint
ALTER TABLE "document_reference" ADD CONSTRAINT "document_reference_batch_identity" UNIQUE("id","import_batch_id","patient_id","hospital_id");--> statement-breakpoint
ALTER TABLE "import_file" ADD CONSTRAINT "import_file_batch_same_record_fk" FOREIGN KEY ("batch_id","patient_id","hospital_id") REFERENCES "public"."import_batch"("id","patient_id","hospital_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_file_same_record_fk" FOREIGN KEY ("file_id","batch_id","patient_id","hospital_id") REFERENCES "public"."import_file"("id","batch_id","patient_id","hospital_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_document_same_batch_fk" FOREIGN KEY ("document_id","batch_id","patient_id","hospital_id") REFERENCES "public"."document_reference"("id","import_batch_id","patient_id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_classified_by_same_hospital_fk" FOREIGN KEY ("classified_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_excluded_by_same_hospital_fk" FOREIGN KEY ("excluded_by_staff_id","hospital_id") REFERENCES "public"."staff_user"("id","hospital_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_file_batch_idx" ON "import_file" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "import_page_batch_idx" ON "import_page" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "import_page_document_idx" ON "import_page" USING btree ("document_id");
