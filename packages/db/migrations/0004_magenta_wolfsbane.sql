CREATE TYPE "public"."db_environment" AS ENUM('local', 'dev', 'staging', 'prod');--> statement-breakpoint
ALTER TABLE "migration_request" ADD COLUMN "promotion_group_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_request" ADD COLUMN "promoted_from_request_id" uuid;--> statement-breakpoint
ALTER TABLE "target_database" ADD COLUMN "environment" "db_environment" DEFAULT 'dev' NOT NULL;--> statement-breakpoint
UPDATE "target_database" SET "environment" = 'prod' WHERE "connection_alias" ILIKE '%prod%' AND "environment" = 'dev';--> statement-breakpoint
UPDATE "target_database" SET "environment" = 'staging' WHERE "connection_alias" ILIKE '%stag%' AND "environment" = 'dev';--> statement-breakpoint
UPDATE "target_database" SET "environment" = 'local' WHERE "connection_alias" ILIKE '%local%' AND "environment" = 'dev';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "migration_request" ADD CONSTRAINT "migration_request_promoted_from_request_id_migration_request_id_fk" FOREIGN KEY ("promoted_from_request_id") REFERENCES "public"."migration_request"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_request_promotion_group_idx" ON "migration_request" USING btree ("promotion_group_id");