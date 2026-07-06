ALTER TABLE "locations" ADD COLUMN "guuid" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "row_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "modified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_locations_sync" ON "locations" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_guuid_unique" UNIQUE("guuid");