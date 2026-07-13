ALTER TABLE "customers" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "logo_uri" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "pan_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "override_credit_limit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "payment_term_lookup_fk" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address_line_1" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address_line_2" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "state_lookup_fk" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "pin_code" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "birthday" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "anniversary" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "logo_uri" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "pan_number" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_term_lookup_fk" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "credit_limit" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "override_credit_limit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address_line_1" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address_line_2" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "state_lookup_fk" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "pin_code" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_payment_term_lookup_fk_lookup_id_fk" FOREIGN KEY ("payment_term_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_state_lookup_fk_lookup_id_fk" FOREIGN KEY ("state_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_term_lookup_fk_lookup_id_fk" FOREIGN KEY ("payment_term_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_state_lookup_fk_lookup_id_fk" FOREIGN KEY ("state_lookup_fk") REFERENCES "public"."lookup"("id") ON DELETE no action ON UPDATE no action;