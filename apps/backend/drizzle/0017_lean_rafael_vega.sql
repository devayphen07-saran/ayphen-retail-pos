CREATE INDEX "idx_account_subscriptions_plan" ON "account_subscriptions" USING btree ("plan_fk");--> statement-breakpoint
CREATE INDEX "idx_accounts_owner" ON "accounts" USING btree ("owner_user_fk");--> statement-breakpoint
CREATE INDEX "idx_invitations_role" ON "invitations" USING btree ("role_fk");--> statement-breakpoint
CREATE INDEX "idx_payment_orders_account" ON "payment_orders" USING btree ("account_fk");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_session" ON "refresh_tokens" USING btree ("device_session_fk");--> statement-breakpoint
CREATE INDEX "idx_sda_user" ON "store_device_access" USING btree ("user_fk");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_or_phone" CHECK ("users"."email" IS NOT NULL OR "users"."phone" IS NOT NULL);