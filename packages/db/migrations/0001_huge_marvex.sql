CREATE TYPE "public"."audit_tone" AS ENUM('green', 'red', 'info', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."preflight_kind" AS ENUM('not_null', 'add_notnull_no_default', 'unique', 'check', 'foreign_key', 'type_change');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preflight_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shadow_run_id" uuid NOT NULL,
	"kind" "preflight_kind" NOT NULL,
	"table_name" text NOT NULL,
	"probe_sql" text,
	"violations" integer,
	"will_fail" boolean,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "expected_confirm_value" text;--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "tone" "audit_tone" DEFAULT 'neutral' NOT NULL;--> statement-breakpoint
ALTER TABLE "target_database" ADD COLUMN "connection_url" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preflight_result" ADD CONSTRAINT "preflight_result_shadow_run_id_shadow_run_id_fk" FOREIGN KEY ("shadow_run_id") REFERENCES "public"."shadow_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preflight_result_shadow_idx" ON "preflight_result" USING btree ("shadow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apply_run_request_idx" ON "apply_run" USING btree ("migration_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apply_run_status_idx" ON "apply_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_decision_idx" ON "approval" USING btree ("decision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_event_created_at_idx" ON "audit_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blast_finding_report_idx" ON "blast_finding" USING btree ("blast_report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blast_finding_severity_idx" ON "blast_finding" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blast_report_shadow_idx" ON "blast_report" USING btree ("shadow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_request_created_at_idx" ON "migration_request" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qodo_review_artifact_idx" ON "qodo_review" USING btree ("generated_artifact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shadow_run_request_idx" ON "shadow_run" USING btree ("migration_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shadow_run_status_idx" ON "shadow_run" USING btree ("status");