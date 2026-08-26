CREATE TYPE "public"."approval_decision" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."intake_kind" AS ENUM('nl_intent', 'raw_sql', 'github_pr');--> statement-breakpoint
CREATE TYPE "public"."qodo_verdict" AS ENUM('passed', 'passed_with_warnings', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('received', 'generating', 'reviewing', 'dry_running', 'awaiting_approval', 'approved', 'rejected', 'applying', 'applied', 'rolled_back', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reversibility" AS ENUM('reversible', 'lossy', 'irreversible');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('green', 'amber', 'red');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apply_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_request_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"lock_timeout_ms" integer DEFAULT 3000 NOT NULL,
	"statement_timeout_ms" integer DEFAULT 30000 NOT NULL,
	"applied_at" timestamp with time zone,
	"rollback_available" boolean DEFAULT true NOT NULL,
	"rolled_back_at" timestamp with time zone,
	"logs" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_request_id" uuid NOT NULL,
	"decision" "approval_decision" DEFAULT 'pending' NOT NULL,
	"approver" text,
	"comment" text,
	"requires_typed_confirm" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_request_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blast_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blast_report_id" uuid NOT NULL,
	"statement_index" integer NOT NULL,
	"statement_sql" text NOT NULL,
	"severity" "severity" NOT NULL,
	"lock_type" text,
	"rows_affected" bigint,
	"explain_json" jsonb,
	"note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blast_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shadow_run_id" uuid NOT NULL,
	"overall_severity" "severity" NOT NULL,
	"total_rows_affected" bigint,
	"est_lock_ms" bigint,
	"est_downtime_ms" bigint,
	"tables_touched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "generated_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_request_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"up_sql" text NOT NULL,
	"down_sql" text NOT NULL,
	"reversibility" "reversibility" NOT NULL,
	"plain_summary" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_database_id" uuid NOT NULL,
	"intake_kind" "intake_kind" NOT NULL,
	"intake_payload" jsonb NOT NULL,
	"title" text NOT NULL,
	"status" "request_status" DEFAULT 'received' NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qodo_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generated_artifact_id" uuid NOT NULL,
	"verdict" "qodo_verdict" NOT NULL,
	"summary" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shadow_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_request_id" uuid NOT NULL,
	"generated_artifact_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"shadow_ref" text,
	"seeded_with_data" boolean DEFAULT false NOT NULL,
	"schema_before_hash" text,
	"schema_after_up_hash" text,
	"schema_after_down_hash" text,
	"rollback_verified" boolean,
	"logs" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "target_database" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"engine" text DEFAULT 'postgres' NOT NULL,
	"connection_alias" text NOT NULL,
	"schema_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "apply_run" ADD CONSTRAINT "apply_run_migration_request_id_migration_request_id_fk" FOREIGN KEY ("migration_request_id") REFERENCES "public"."migration_request"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval" ADD CONSTRAINT "approval_migration_request_id_migration_request_id_fk" FOREIGN KEY ("migration_request_id") REFERENCES "public"."migration_request"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_migration_request_id_migration_request_id_fk" FOREIGN KEY ("migration_request_id") REFERENCES "public"."migration_request"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "blast_finding" ADD CONSTRAINT "blast_finding_blast_report_id_blast_report_id_fk" FOREIGN KEY ("blast_report_id") REFERENCES "public"."blast_report"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "blast_report" ADD CONSTRAINT "blast_report_shadow_run_id_shadow_run_id_fk" FOREIGN KEY ("shadow_run_id") REFERENCES "public"."shadow_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "generated_artifact" ADD CONSTRAINT "generated_artifact_migration_request_id_migration_request_id_fk" FOREIGN KEY ("migration_request_id") REFERENCES "public"."migration_request"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "migration_request" ADD CONSTRAINT "migration_request_target_database_id_target_database_id_fk" FOREIGN KEY ("target_database_id") REFERENCES "public"."target_database"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "qodo_review" ADD CONSTRAINT "qodo_review_generated_artifact_id_generated_artifact_id_fk" FOREIGN KEY ("generated_artifact_id") REFERENCES "public"."generated_artifact"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shadow_run" ADD CONSTRAINT "shadow_run_migration_request_id_migration_request_id_fk" FOREIGN KEY ("migration_request_id") REFERENCES "public"."migration_request"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shadow_run" ADD CONSTRAINT "shadow_run_generated_artifact_id_generated_artifact_id_fk" FOREIGN KEY ("generated_artifact_id") REFERENCES "public"."generated_artifact"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_request_uq" ON "approval" USING btree ("migration_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_event_req_time_idx" ON "audit_event" USING btree ("migration_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "generated_artifact_req_version_uq" ON "generated_artifact" USING btree ("migration_request_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_request_status_idx" ON "migration_request" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_request_target_idx" ON "migration_request" USING btree ("target_database_id");