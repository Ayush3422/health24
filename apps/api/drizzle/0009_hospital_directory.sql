CREATE TABLE "hospital_directory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"facility_type" "facility_type" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hospital_directory" ADD CONSTRAINT "hospital_directory_id_hospital_id_fk" FOREIGN KEY ("id") REFERENCES "public"."hospital"("id") ON DELETE cascade ON UPDATE no action;