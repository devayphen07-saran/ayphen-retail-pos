CREATE TABLE "subscription_audit_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_fk" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "subscription_audit_outbox" ADD CONSTRAINT "subscription_audit_outbox_account_fk_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sub_outbox_pending" ON "subscription_audit_outbox" USING btree ("created_at") WHERE "subscription_audit_outbox"."processed_at" IS NULL;