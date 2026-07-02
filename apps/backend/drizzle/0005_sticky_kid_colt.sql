CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_device_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"device_fk" uuid NOT NULL,
	"user_fk" uuid NOT NULL,
	"location_fk" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"device_label" text,
	"first_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_device_access" ADD CONSTRAINT "store_device_access_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_device_access" ADD CONSTRAINT "store_device_access_device_fk_devices_id_fk" FOREIGN KEY ("device_fk") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_device_access" ADD CONSTRAINT "store_device_access_user_fk_users_id_fk" FOREIGN KEY ("user_fk") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_device_access" ADD CONSTRAINT "store_device_access_location_fk_locations_id_fk" FOREIGN KEY ("location_fk") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_device_access" ADD CONSTRAINT "store_device_access_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_location_primary" ON "locations" USING btree ("store_fk") WHERE "locations"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "idx_location_store_active" ON "locations" USING btree ("store_fk") WHERE "locations"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_sda_active" ON "store_device_access" USING btree ("store_fk","device_fk") WHERE "store_device_access"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_sda_store" ON "store_device_access" USING btree ("store_fk");--> statement-breakpoint
CREATE INDEX "idx_sda_device" ON "store_device_access" USING btree ("device_fk");