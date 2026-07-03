CREATE TABLE "address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"entity_type_fk" uuid NOT NULL,
	"record_id" uuid,
	"record_guuid" uuid NOT NULL,
	"address_type_lookup_fk" uuid,
	"line1" varchar(200) NOT NULL,
	"line2" varchar(200),
	"city" varchar(100),
	"state_code" varchar(2),
	"pincode" varchar(6),
	"country_fk" uuid,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_billing" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "address_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "communication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"entity_type_fk" uuid NOT NULL,
	"record_id" uuid,
	"record_guuid" uuid NOT NULL,
	"communication_type_lookup_fk" uuid,
	"email" varchar(255),
	"phone" varchar(20),
	"fax" varchar(20),
	"website" varchar(255),
	"calling_code" varchar(10),
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "communication_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "contact_person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"entity_type_fk" uuid NOT NULL,
	"record_id" uuid,
	"record_guuid" uuid NOT NULL,
	"contact_type_lookup_fk" uuid,
	"salutation_lookup_fk" uuid,
	"first_name" varchar(50),
	"last_name" varchar(50),
	"designation" varchar(50),
	"email" varchar(255),
	"office_number" varchar(20),
	"mobile_number" varchar(20),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "contact_person_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"entity_type_fk" uuid NOT NULL,
	"record_id" uuid,
	"record_guuid" uuid NOT NULL,
	"store_fk" uuid,
	"kind" varchar(50) NOT NULL,
	"storage_key" varchar(1000) NOT NULL,
	"storage_url" text,
	"thumbnail_url" text,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" varchar(64),
	"original_filename" varchar(255),
	"is_private" boolean DEFAULT true NOT NULL,
	"description" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "files_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "files_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type_fk" uuid NOT NULL,
	"file_kind" varchar(50),
	"max_file_size_bytes" bigint NOT NULL,
	"max_consolidated_size_bytes" bigint NOT NULL,
	"valid_extensions" varchar(1000) NOT NULL,
	"max_attachments_allowed" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_fk" uuid NOT NULL,
	"location_fk" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lookup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"lookup_type_fk" uuid NOT NULL,
	"store_fk" uuid,
	"code" varchar(40) NOT NULL,
	"label" varchar(80) NOT NULL,
	"description" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lookup_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "uk_lookup_type_id" UNIQUE("lookup_type_fk","id")
);
--> statement-breakpoint
CREATE TABLE "lookup_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"title" varchar(80) NOT NULL,
	"description" varchar(200),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lookup_type_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"entity_type_fk" uuid NOT NULL,
	"record_id" uuid,
	"record_guuid" uuid NOT NULL,
	"store_fk" uuid NOT NULL,
	"body" text NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "notes_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "temporary_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"storage_key" varchar(1000) NOT NULL,
	"storage_url" text,
	"size_bytes" bigint NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"sha256" varchar(64),
	"uploaded_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temporary_files_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_entity_type_fk_entity_types_id_fk" FOREIGN KEY ("entity_type_fk") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_address_type_lookup_fk_lookup_id_fk" FOREIGN KEY ("address_type_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_entity_type_fk_entity_types_id_fk" FOREIGN KEY ("entity_type_fk") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_communication_type_lookup_fk_lookup_id_fk" FOREIGN KEY ("communication_type_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_person" ADD CONSTRAINT "contact_person_entity_type_fk_entity_types_id_fk" FOREIGN KEY ("entity_type_fk") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_person" ADD CONSTRAINT "contact_person_contact_type_lookup_fk_lookup_id_fk" FOREIGN KEY ("contact_type_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_person" ADD CONSTRAINT "contact_person_salutation_lookup_fk_lookup_id_fk" FOREIGN KEY ("salutation_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_entity_type_fk_entity_types_id_fk" FOREIGN KEY ("entity_type_fk") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_config" ADD CONSTRAINT "files_config_entity_type_fk_entity_types_id_fk" FOREIGN KEY ("entity_type_fk") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_locations" ADD CONSTRAINT "invitation_locations_invitation_fk_invitations_id_fk" FOREIGN KEY ("invitation_fk") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_locations" ADD CONSTRAINT "invitation_locations_location_fk_locations_id_fk" FOREIGN KEY ("location_fk") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookup" ADD CONSTRAINT "lookup_lookup_type_fk_lookup_type_id_fk" FOREIGN KEY ("lookup_type_fk") REFERENCES "public"."lookup_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookup" ADD CONSTRAINT "lookup_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_entity_type_fk_entity_types_id_fk" FOREIGN KEY ("entity_type_fk") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_files" ADD CONSTRAINT "temporary_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_address_entity_record" ON "address" USING btree ("entity_type_fk","record_guuid");--> statement-breakpoint
CREATE INDEX "idx_communication_entity_record" ON "communication" USING btree ("entity_type_fk","record_guuid");--> statement-breakpoint
CREATE INDEX "idx_contact_person_entity_record" ON "contact_person" USING btree ("entity_type_fk","record_guuid");--> statement-breakpoint
CREATE INDEX "idx_files_entity_record" ON "files" USING btree ("entity_type_fk","record_guuid");--> statement-breakpoint
CREATE INDEX "idx_files_store" ON "files" USING btree ("store_fk");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_files_config_entity_kind" ON "files_config" USING btree ("entity_type_fk","file_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_invitation_locations" ON "invitation_locations" USING btree ("invitation_fk","location_fk");--> statement-breakpoint
CREATE INDEX "idx_invitation_locations_invitation" ON "invitation_locations" USING btree ("invitation_fk");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_lookup_type_code" ON "lookup" USING btree ("lookup_type_fk","code");--> statement-breakpoint
CREATE INDEX "idx_lookup_type" ON "lookup" USING btree ("lookup_type_fk");--> statement-breakpoint
CREATE INDEX "idx_lookup_store" ON "lookup" USING btree ("store_fk");--> statement-breakpoint
CREATE INDEX "idx_notes_entity_record" ON "notes" USING btree ("entity_type_fk","record_guuid");