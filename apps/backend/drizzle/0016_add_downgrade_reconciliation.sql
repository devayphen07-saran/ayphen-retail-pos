ALTER TABLE "account_subscriptions" ADD COLUMN "reconciliation_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD COLUMN "reconciliation_effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "locked_reason" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "locked_reason" text;