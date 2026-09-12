CREATE TYPE "public"."code_system_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."designation_use" AS ENUM('display', 'synonym', 'transliteration');--> statement-breakpoint
CREATE TYPE "public"."map_element_status" AS ENUM('proposed', 'approved', 'rejected', 'retired');--> statement-breakpoint
CREATE TYPE "public"."map_equivalence" AS ENUM('equivalent', 'wider', 'narrower', 'inexact', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."map_provenance" AS ENUM('imported', 'curated');--> statement-breakpoint
CREATE TYPE "public"."map_review_action" AS ENUM('import', 'propose', 'approve', 'reject', 'retire');--> statement-breakpoint
CREATE TYPE "public"."map_review_policy" AS ENUM('authoritative', 'requires_review');--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'terminology_curator' BEFORE 'hospital_admin';--> statement-breakpoint
CREATE TABLE "code_system" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"uri" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"publisher" text NOT NULL,
	"status" "code_system_status" DEFAULT 'draft' NOT NULL,
	"experimental" boolean DEFAULT false NOT NULL,
	"licence" text,
	"attribution" text,
	"released_at" date,
	"content_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" text NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by_staff_id" uuid,
	"retired_at" timestamp with time zone,
	CONSTRAINT "code_system_key_version_unique" UNIQUE("key","version")
);
--> statement-breakpoint
CREATE TABLE "concept_designation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"concept_id" uuid NOT NULL,
	"language" text NOT NULL,
	"use" "designation_use" NOT NULL,
	"value" text NOT NULL,
	"value_folded" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_map_element" (
	"id" uuid PRIMARY KEY NOT NULL,
	"concept_map_id" uuid NOT NULL,
	"source_code" text NOT NULL,
	"target_code" text,
	"equivalence" "map_equivalence" NOT NULL,
	"confidence" double precision,
	"comment" text,
	"status" "map_element_status" DEFAULT 'proposed' NOT NULL,
	"provenance" "map_provenance" NOT NULL,
	"proposed_by_staff_id" uuid,
	"reviewed_by_staff_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"supersedes_element_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_map_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"element_id" uuid NOT NULL,
	"action" "map_review_action" NOT NULL,
	"staff_id" uuid,
	"actor_label" text NOT NULL,
	"comment" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_map" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"publisher" text NOT NULL,
	"source_system_id" uuid NOT NULL,
	"target_system_id" uuid NOT NULL,
	"experimental" boolean DEFAULT false NOT NULL,
	"review_policy" "map_review_policy" NOT NULL,
	"licence" text,
	"attribution" text,
	"content_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" text NOT NULL,
	CONSTRAINT "concept_map_key_version_unique" UNIQUE("key","version")
);
--> statement-breakpoint
CREATE TABLE "concept" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_system_id" uuid NOT NULL,
	"code" text NOT NULL,
	"display" text NOT NULL,
	"definition" text,
	"parent_code" text,
	CONSTRAINT "concept_system_code_unique" UNIQUE("code_system_id","code")
);
--> statement-breakpoint
ALTER TABLE "code_system" ADD CONSTRAINT "code_system_activated_by_staff_id_staff_user_id_fk" FOREIGN KEY ("activated_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_designation" ADD CONSTRAINT "concept_designation_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_element" ADD CONSTRAINT "concept_map_element_concept_map_id_concept_map_id_fk" FOREIGN KEY ("concept_map_id") REFERENCES "public"."concept_map"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_element" ADD CONSTRAINT "concept_map_element_proposed_by_staff_id_staff_user_id_fk" FOREIGN KEY ("proposed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_element" ADD CONSTRAINT "concept_map_element_reviewed_by_staff_id_staff_user_id_fk" FOREIGN KEY ("reviewed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_element" ADD CONSTRAINT "concept_map_element_supersedes_element_id_concept_map_element_id_fk" FOREIGN KEY ("supersedes_element_id") REFERENCES "public"."concept_map_element"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_review" ADD CONSTRAINT "concept_map_review_element_id_concept_map_element_id_fk" FOREIGN KEY ("element_id") REFERENCES "public"."concept_map_element"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_review" ADD CONSTRAINT "concept_map_review_staff_id_staff_user_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map" ADD CONSTRAINT "concept_map_source_system_id_code_system_id_fk" FOREIGN KEY ("source_system_id") REFERENCES "public"."code_system"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map" ADD CONSTRAINT "concept_map_target_system_id_code_system_id_fk" FOREIGN KEY ("target_system_id") REFERENCES "public"."code_system"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept" ADD CONSTRAINT "concept_code_system_id_code_system_id_fk" FOREIGN KEY ("code_system_id") REFERENCES "public"."code_system"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_system_key_idx" ON "code_system" USING btree ("key");--> statement-breakpoint
CREATE INDEX "concept_designation_concept_idx" ON "concept_designation" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "concept_map_element_lookup_idx" ON "concept_map_element" USING btree ("concept_map_id","source_code","status");--> statement-breakpoint
CREATE INDEX "concept_map_element_status_idx" ON "concept_map_element" USING btree ("status");--> statement-breakpoint
CREATE INDEX "concept_map_review_element_idx" ON "concept_map_review" USING btree ("element_id");--> statement-breakpoint
CREATE INDEX "concept_parent_idx" ON "concept" USING btree ("code_system_id","parent_code");