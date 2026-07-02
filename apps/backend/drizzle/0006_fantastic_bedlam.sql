CREATE TABLE "user_location_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_fk" uuid NOT NULL,
	"location_fk" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "enable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_location_mappings" ADD CONSTRAINT "user_location_mappings_user_fk_users_id_fk" FOREIGN KEY ("user_fk") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_location_mappings" ADD CONSTRAINT "user_location_mappings_location_fk_locations_id_fk" FOREIGN KEY ("location_fk") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_location_mappings" ADD CONSTRAINT "user_location_mappings_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_ulm_user_location" ON "user_location_mappings" USING btree ("user_fk","location_fk");--> statement-breakpoint
CREATE INDEX "idx_ulm_user_active" ON "user_location_mappings" USING btree ("user_fk","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_ulm_location" ON "user_location_mappings" USING btree ("location_fk");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_location_default" ON "locations" USING btree ("store_fk") WHERE "locations"."is_default" = true;