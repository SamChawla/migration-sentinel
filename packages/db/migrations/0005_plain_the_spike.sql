CREATE TABLE IF NOT EXISTS "github_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_request_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"file_path" text NOT NULL,
	"pr_title" text,
	"pr_state" text,
	"head_sha" text,
	"checks_state" text,
	"html_url" text,
	"last_synced_at" timestamp with time zone,
	"comment_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_link" ADD CONSTRAINT "github_link_migration_request_id_migration_request_id_fk" FOREIGN KEY ("migration_request_id") REFERENCES "public"."migration_request"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_link_request_uq" ON "github_link" USING btree ("migration_request_id");