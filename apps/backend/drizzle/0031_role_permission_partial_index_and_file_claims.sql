DROP INDEX "role_permissions_role_entity_action_uq";--> statement-breakpoint
DROP INDEX "role_special_permissions_uq";--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "row_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "temporary_files" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_temporary_files_expires_at" ON "temporary_files" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_role_entity_action_uq" ON "role_permissions" USING btree ("role_fk","entity_code","action") WHERE "role_permissions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_special_permissions_uq" ON "role_special_permissions" USING btree ("role_fk","entity_code","action_code") WHERE "role_special_permissions"."revoked_at" IS NULL;