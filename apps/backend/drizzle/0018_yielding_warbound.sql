CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"gst_number" text,
	"customer_type_lookup_fk" uuid,
	"credit_limit" numeric(12, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "customers_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"payment_method_fk" uuid,
	"details" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "payment_accounts_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "payment_methods_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "product_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"product_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"barcode" text,
	"selling_price" numeric(12, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "product_cases_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"barcode" text,
	"category_lookup_fk" uuid,
	"unit_fk" uuid,
	"taxrate_fk" uuid,
	"selling_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"cost_price" numeric(12, 2),
	"mrp" numeric(12, 2),
	"hsn_code" text,
	"track_inventory" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "products_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"gst_number" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "suppliers_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mutation_id" text NOT NULL,
	"user_fk" uuid NOT NULL,
	"store_fk" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_guuid" uuid,
	"conflict_type" text NOT NULL,
	"server_row" jsonb,
	"client_payload" jsonb NOT NULL,
	"message" text,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_init_progress" (
	"store_fk" uuid NOT NULL,
	"device_fk" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"phase" text DEFAULT 'in_progress' NOT NULL,
	"cursor" text,
	"session_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_init_progress_store_fk_device_fk_entity_type_pk" PRIMARY KEY("store_fk","device_fk","entity_type")
);
--> statement-breakpoint
CREATE TABLE "sync_mutation_failures" (
	"mutation_id" text NOT NULL,
	"user_fk" uuid NOT NULL,
	"failure_count" integer DEFAULT 1 NOT NULL,
	"last_error_message" text,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_mutation_failures_mutation_id_user_fk_pk" PRIMARY KEY("mutation_id","user_fk")
);
--> statement-breakpoint
CREATE TABLE "sync_mutation_idempotency" (
	"mutation_id" text NOT NULL,
	"user_fk" uuid NOT NULL,
	"store_fk" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_mutation_idempotency_mutation_id_user_fk_pk" PRIMARY KEY("mutation_id","user_fk")
);
--> statement-breakpoint
CREATE TABLE "sync_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_guuid" uuid NOT NULL,
	"entity_id" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by_user_fk" uuid,
	"hard_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxrates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"rate_percent" numeric(6, 3) NOT NULL,
	"is_inclusive" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "taxrates_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text NOT NULL,
	"allows_fractions" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_by" uuid,
	CONSTRAINT "units_guuid_unique" UNIQUE("guuid")
);
--> statement-breakpoint
ALTER TABLE "lookup" ADD COLUMN "row_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lookup" ADD COLUMN "modified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "store_device_access" ADD COLUMN "guuid" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "guuid" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "modified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "modified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_type_lookup_fk_lookup_id_fk" FOREIGN KEY ("customer_type_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_payment_method_fk_payment_methods_id_fk" FOREIGN KEY ("payment_method_fk") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_cases" ADD CONSTRAINT "product_cases_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_cases" ADD CONSTRAINT "product_cases_product_fk_products_id_fk" FOREIGN KEY ("product_fk") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_lookup_fk_lookup_id_fk" FOREIGN KEY ("category_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_unit_fk_units_id_fk" FOREIGN KEY ("unit_fk") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_taxrate_fk_taxrates_id_fk" FOREIGN KEY ("taxrate_fk") REFERENCES "public"."taxrates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_user_fk_users_id_fk" FOREIGN KEY ("user_fk") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_init_progress" ADD CONSTRAINT "sync_init_progress_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_init_progress" ADD CONSTRAINT "sync_init_progress_device_fk_devices_id_fk" FOREIGN KEY ("device_fk") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mutation_failures" ADD CONSTRAINT "sync_mutation_failures_user_fk_users_id_fk" FOREIGN KEY ("user_fk") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mutation_idempotency" ADD CONSTRAINT "sync_mutation_idempotency_user_fk_users_id_fk" FOREIGN KEY ("user_fk") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxrates" ADD CONSTRAINT "taxrates_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customers_sync" ON "customers" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_customers_phone" ON "customers" USING btree ("store_fk","phone");--> statement-breakpoint
CREATE INDEX "idx_payment_accounts_sync" ON "payment_accounts" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_payment_methods_store_code" ON "payment_methods" USING btree ("store_fk","code");--> statement-breakpoint
CREATE INDEX "idx_payment_methods_sync" ON "payment_methods" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_product_cases_sync" ON "product_cases" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_product_cases_product" ON "product_cases" USING btree ("product_fk");--> statement-breakpoint
CREATE INDEX "idx_products_sync" ON "products" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_products_barcode" ON "products" USING btree ("store_fk","barcode");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_products_store_sku" ON "products" USING btree ("store_fk","sku") WHERE "products"."sku" IS NOT NULL AND "products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_suppliers_sync" ON "suppliers" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_sync_conflicts_mutation" ON "sync_conflicts" USING btree ("mutation_id","user_fk");--> statement-breakpoint
CREATE INDEX "idx_sync_conflicts_store_status" ON "sync_conflicts" USING btree ("store_fk","status");--> statement-breakpoint
CREATE INDEX "idx_sync_idem_created" ON "sync_mutation_idempotency" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_tombstone_entity" ON "sync_tombstones" USING btree ("entity_type","entity_guuid");--> statement-breakpoint
CREATE INDEX "idx_tombstones_stream" ON "sync_tombstones" USING btree ("store_fk","deleted_at","id");--> statement-breakpoint
CREATE INDEX "idx_taxrates_sync" ON "taxrates" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_units_sync" ON "units" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_lookup_sync" ON "lookup" USING btree ("modified_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_guuid_uq" ON "users" USING btree ("guuid");--> statement-breakpoint
ALTER TABLE "store_device_access" ADD CONSTRAINT "store_device_access_guuid_unique" UNIQUE("guuid");--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_guuid_unique" UNIQUE("guuid");