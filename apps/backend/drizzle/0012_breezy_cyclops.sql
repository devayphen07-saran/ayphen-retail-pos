CREATE TABLE "processed_payment_events" (
	"provider_ref" text PRIMARY KEY NOT NULL,
	"account_fk" uuid NOT NULL,
	"order_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "processed_payment_events" ADD CONSTRAINT "processed_payment_events_account_fk_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;