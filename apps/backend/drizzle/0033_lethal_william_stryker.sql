ALTER TABLE "payment_accounts" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD COLUMN "system_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_payment_accounts_store_name" ON "payment_accounts" USING btree ("store_fk",lower("name")) WHERE "payment_accounts"."deleted_at" IS NULL AND "payment_accounts"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "uk_payment_accounts_one_default" ON "payment_accounts" USING btree ("store_fk") WHERE "payment_accounts"."is_default" AND "payment_accounts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_payment_accounts_system_key" ON "payment_accounts" USING btree ("store_fk","system_key") WHERE "payment_accounts"."system_key" IS NOT NULL;