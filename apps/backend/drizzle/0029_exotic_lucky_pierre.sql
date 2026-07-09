ALTER TABLE "invitation_locations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "locations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_location_mappings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "invitation_locations" CASCADE;--> statement-breakpoint
DROP TABLE "locations" CASCADE;--> statement-breakpoint
DROP TABLE "user_location_mappings" CASCADE;--> statement-breakpoint
ALTER TABLE "store_device_access" DROP COLUMN "location_fk";