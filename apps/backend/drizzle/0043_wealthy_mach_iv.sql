CREATE TABLE "supplier_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"supplier_fk" uuid NOT NULL,
	"bill_no" text,
	"amount_paise" integer NOT NULL,
	"bill_date" timestamp with time zone DEFAULT now() NOT NULL,
	"due_date" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"device_fk" uuid,
	CONSTRAINT "supplier_bills_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_supplier_bills_amount_positive" CHECK ("supplier_bills"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"supplier_fk" uuid NOT NULL,
	"account_fk" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"device_fk" uuid,
	CONSTRAINT "supplier_payments_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_supplier_payments_amount_positive" CHECK ("supplier_payments"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_payment_fk_customer_payments_id_fk";
--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplier_fk_suppliers_id_fk" FOREIGN KEY ("supplier_fk") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_fk_suppliers_id_fk" FOREIGN KEY ("supplier_fk") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_account_fk_payment_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_supplier_bills_sync" ON "supplier_bills" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_supplier_bills_supplier" ON "supplier_bills" USING btree ("supplier_fk");--> statement-breakpoint
CREATE INDEX "idx_supplier_payments_sync" ON "supplier_payments" USING btree ("store_fk","modified_at","id");