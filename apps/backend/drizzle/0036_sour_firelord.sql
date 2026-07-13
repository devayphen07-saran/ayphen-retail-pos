ALTER TABLE "payment_accounts" DROP CONSTRAINT "payment_accounts_payment_method_fk_payment_methods_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_accounts" DROP COLUMN "payment_method_fk";