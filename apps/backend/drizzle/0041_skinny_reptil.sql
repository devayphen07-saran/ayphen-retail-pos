CREATE TABLE "refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"refund_fk" uuid NOT NULL,
	"sale_line_fk" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"amount_paise" integer NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_lines_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_refund_lines_qty_positive" CHECK ("refund_lines"."qty" > 0),
	CONSTRAINT "ck_refund_lines_amount_positive" CHECK ("refund_lines"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"sale_fk" uuid NOT NULL,
	"account_fk" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" text,
	"refunded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"device_fk" uuid,
	CONSTRAINT "refunds_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_refunds_amount_positive" CHECK ("refunds"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"sale_fk" uuid NOT NULL,
	"product_fk" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"line_total_paise" integer NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_lines_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_sale_lines_qty_positive" CHECK ("sale_lines"."qty" > 0),
	CONSTRAINT "ck_sale_lines_line_total_nonnegative" CHECK ("sale_lines"."line_total_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"sale_fk" uuid NOT NULL,
	"account_fk" uuid NOT NULL,
	"tender" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_payments_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_sale_payments_amount_positive" CHECK ("sale_payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"total_paise" integer NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"invoice_no" text,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"device_fk" uuid,
	CONSTRAINT "sales_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_sales_total_positive" CHECK ("sales"."total_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_fk_refunds_id_fk" FOREIGN KEY ("refund_fk") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_sale_line_fk_sale_lines_id_fk" FOREIGN KEY ("sale_line_fk") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_sale_fk_sales_id_fk" FOREIGN KEY ("sale_fk") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_account_fk_payment_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_fk_sales_id_fk" FOREIGN KEY ("sale_fk") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_fk_products_id_fk" FOREIGN KEY ("product_fk") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_fk_sales_id_fk" FOREIGN KEY ("sale_fk") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_account_fk_payment_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_refund_lines_sync" ON "refund_lines" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_refund_lines_refund" ON "refund_lines" USING btree ("refund_fk");--> statement-breakpoint
CREATE INDEX "idx_refunds_sync" ON "refunds" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_refunds_sale" ON "refunds" USING btree ("sale_fk");--> statement-breakpoint
CREATE INDEX "idx_sale_lines_sync" ON "sale_lines" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_sale_lines_sale" ON "sale_lines" USING btree ("sale_fk");--> statement-breakpoint
CREATE INDEX "idx_sale_payments_sync" ON "sale_payments" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_sale_payments_sale" ON "sale_payments" USING btree ("sale_fk");--> statement-breakpoint
CREATE INDEX "idx_sales_sync" ON "sales" USING btree ("store_fk","modified_at","id");