CREATE TABLE "entity_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"is_offline_safe" boolean DEFAULT false NOT NULL,
	"supports_attachments" boolean DEFAULT false NOT NULL,
	CONSTRAINT "entity_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "role_special_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_fk" uuid NOT NULL,
	"entity_code" text NOT NULL,
	"action_code" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_role_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_fk" uuid NOT NULL,
	"role_fk" uuid NOT NULL,
	"store_fk" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_name_unique";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_roles_id_fk";
--> statement-breakpoint
DROP INDEX "role_permissions_uq";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_user_fk" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "gst_number" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "billing_address" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "store_fk" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "is_success" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "role_fk" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "entity_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "action" text NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "granted_by" uuid;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "granted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "guuid" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "store_fk" uuid;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "is_editable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "role_special_permissions" ADD CONSTRAINT "role_special_permissions_role_fk_roles_id_fk" FOREIGN KEY ("role_fk") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_special_permissions" ADD CONSTRAINT "role_special_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_mappings" ADD CONSTRAINT "user_role_mappings_user_fk_users_id_fk" FOREIGN KEY ("user_fk") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_mappings" ADD CONSTRAINT "user_role_mappings_role_fk_roles_id_fk" FOREIGN KEY ("role_fk") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_mappings" ADD CONSTRAINT "user_role_mappings_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_mappings" ADD CONSTRAINT "user_role_mappings_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_special_permissions_uq" ON "role_special_permissions" USING btree ("role_fk","entity_code","action_code");--> statement-breakpoint
CREATE INDEX "idx_role_special_permissions_role" ON "role_special_permissions" USING btree ("role_fk");--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_mappings_uq" ON "user_role_mappings" USING btree ("user_fk","role_fk","store_fk");--> statement-breakpoint
CREATE INDEX "idx_user_role_mappings_user_store" ON "user_role_mappings" USING btree ("user_fk","store_fk");--> statement-breakpoint
CREATE INDEX "idx_user_role_mappings_role" ON "user_role_mappings" USING btree ("role_fk");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_fk_users_id_fk" FOREIGN KEY ("owner_user_fk") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fk_roles_id_fk" FOREIGN KEY ("role_fk") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_users_user" ON "account_users" USING btree ("user_fk");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_role_entity_action_uq" ON "role_permissions" USING btree ("role_fk","entity_code","action");--> statement-breakpoint
CREATE INDEX "idx_role_permissions_role" ON "role_permissions" USING btree ("role_fk");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_system_code_uq" ON "roles" USING btree ("code") WHERE "roles"."store_fk" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_store_name_uq" ON "roles" USING btree ("store_fk","name");--> statement-breakpoint
CREATE INDEX "idx_roles_store" ON "roles" USING btree ("store_fk");--> statement-breakpoint
ALTER TABLE "account_users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP COLUMN "role_id";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP COLUMN "permission";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_guuid_unique" UNIQUE("guuid");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "system_role_no_store" CHECK ("roles"."store_fk" IS NULL OR "roles"."code" NOT IN ('SUPER_ADMIN', 'USER'));