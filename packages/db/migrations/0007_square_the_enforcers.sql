ALTER TABLE "github_link" ADD COLUMN "export_branch" text;--> statement-breakpoint
ALTER TABLE "github_link" ADD COLUMN "export_pr_number" integer;--> statement-breakpoint
ALTER TABLE "github_link" ADD COLUMN "export_pr_url" text;--> statement-breakpoint
ALTER TABLE "github_link" ADD COLUMN "export_pr_state" text;--> statement-breakpoint
ALTER TABLE "github_link" ADD COLUMN "export_merged_at" timestamp with time zone;