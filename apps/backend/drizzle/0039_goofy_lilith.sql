CREATE TABLE "account_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"account_fk" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" text NOT NULL,
	"source_type" text NOT NULL,
	"source_fk" uuid NOT NULL,
	"shift_session_fk" uuid,
	"note" text,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"device_fk" uuid,
	CONSTRAINT "account_transactions_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_account_transactions_amount_positive" CHECK ("account_transactions"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"account_fk" uuid NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"amount_paise" integer NOT NULL,
	"by_user_fk" uuid NOT NULL,
	"guuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"device_fk" uuid,
	CONSTRAINT "cash_movements_guuid_unique" UNIQUE("guuid"),
	CONSTRAINT "ck_cash_movements_amount_positive" CHECK ("cash_movements"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_account_fk_payment_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_account_fk_payment_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_transactions_sync" ON "account_transactions" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_account_transactions_account" ON "account_transactions" USING btree ("account_fk","created_at");--> statement-breakpoint
CREATE INDEX "idx_cash_movements_sync" ON "cash_movements" USING btree ("store_fk","modified_at","id");--> statement-breakpoint
CREATE INDEX "idx_cash_movements_account" ON "cash_movements" USING btree ("account_fk","created_at");