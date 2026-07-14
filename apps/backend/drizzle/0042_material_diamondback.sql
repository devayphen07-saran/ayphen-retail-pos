CREATE TABLE "customer_ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"customer_fk" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_fk" uuid NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "customer_ledger_events_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_customer_ledger_events_amount_positive" CHECK ("customer_ledger_events"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"customer_fk" uuid NOT NULL,
	"account_fk" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"device_fk" uuid,
	CONSTRAINT "customer_payments_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_customer_payments_amount_positive" CHECK ("customer_payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"payment_fk" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_fk" uuid NOT NULL,
	"applied_paise" integer NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_payment_allocations_applied_positive" CHECK ("payment_allocations"."applied_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "sale_payments" ALTER COLUMN "account_fk" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "on_credit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "customer_fk" uuid;--> statement-breakpoint
ALTER TABLE "customer_ledger_events" ADD CONSTRAINT "customer_ledger_events_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger_events" ADD CONSTRAINT "customer_ledger_events_customer_fk_customers_id_fk" FOREIGN KEY ("customer_fk") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_fk_customers_id_fk" FOREIGN KEY ("customer_fk") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_account_fk_payment_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk_customer_payments_id_fk" FOREIGN KEY ("payment_fk") REFERENCES "public"."customer_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_ledger_events_sync" ON "customer_ledger_events" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_customer_ledger_events_customer" ON "customer_ledger_events" USING btree ("customer_fk","created_at");--> statement-breakpoint
CREATE INDEX "idx_customer_payments_sync" ON "customer_payments" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_payment_allocations_sync" ON "payment_allocations" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_payment_allocations_payment" ON "payment_allocations" USING btree ("payment_fk");--> statement-breakpoint
CREATE INDEX "idx_payment_allocations_target" ON "payment_allocations" USING btree ("target_type","target_fk");--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_fk_customers_id_fk" FOREIGN KEY ("customer_fk") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "ck_sale_payments_credit_has_no_account" CHECK (("sale_payments"."on_credit" AND "sale_payments"."account_fk" IS NULL) OR (NOT "sale_payments"."on_credit" AND "sale_payments"."account_fk" IS NOT NULL));