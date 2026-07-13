CREATE TABLE "opening_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_fk" uuid NOT NULL,
	"account_fk" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "ck_opening_balances_amount_positive" CHECK ("opening_balances"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_account_fk_payment_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_opening_balances_account" ON "opening_balances" USING btree ("account_fk");