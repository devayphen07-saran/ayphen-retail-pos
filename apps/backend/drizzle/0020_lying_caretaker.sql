ALTER TABLE "subscription_audit_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_audit_outbox" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_user_role_mappings_store" ON "user_role_mappings" USING btree ("store_fk");--> statement-breakpoint
CREATE INDEX "idx_users_modified" ON "users" USING btree ("modified_at","id");