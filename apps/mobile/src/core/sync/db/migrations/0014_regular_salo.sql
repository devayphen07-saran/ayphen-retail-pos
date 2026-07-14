CREATE TABLE `customer_ledger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`customer_fk` text NOT NULL,
	`kind` text,
	`amount_paise` integer NOT NULL,
	`source_type` text,
	`source_fk` text,
	`flagged` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`customer_fk` text NOT NULL,
	`account_fk` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`paid_at` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`payment_fk` text NOT NULL,
	`target_type` text,
	`target_fk` text NOT NULL,
	`applied_paise` integer NOT NULL,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `refund_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`refund_fk` text NOT NULL,
	`sale_line_fk` text NOT NULL,
	`qty` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`sale_fk` text NOT NULL,
	`account_fk` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`reason` text,
	`refunded_at` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sale_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`sale_fk` text NOT NULL,
	`product_fk` text NOT NULL,
	`qty` text NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`discount_paise` integer NOT NULL,
	`line_total_paise` integer NOT NULL,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sale_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`sale_fk` text NOT NULL,
	`account_fk` text,
	`tender` text,
	`amount_paise` integer NOT NULL,
	`on_credit` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`customer_fk` text,
	`total_paise` integer NOT NULL,
	`status` text,
	`invoice_no` text,
	`sold_at` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplier_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`supplier_fk` text NOT NULL,
	`bill_no` text,
	`amount_paise` integer NOT NULL,
	`bill_date` text,
	`due_date` text,
	`status` text,
	`notes` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplier_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`supplier_fk` text NOT NULL,
	`account_fk` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`paid_at` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
