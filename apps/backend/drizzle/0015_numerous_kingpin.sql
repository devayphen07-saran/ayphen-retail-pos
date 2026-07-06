CREATE TABLE "payment_orders" (
	"order_id" text PRIMARY KEY NOT NULL,
	"account_fk" uuid NOT NULL,
	"plan_fk" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_account_fk_accounts_id_fk" FOREIGN KEY ("account_fk") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_plan_fk_plans_id_fk" FOREIGN KEY ("plan_fk") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;