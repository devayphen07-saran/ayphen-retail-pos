CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`email` text,
	`gst_number` text,
	`customer_type_lookup_fk` text,
	`credit_limit` text,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `failed_applies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_guuid` text NOT NULL,
	`data` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `lookups` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text,
	`guuid` text NOT NULL,
	`lookup_type_fk` text NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`sort_order` integer,
	`is_hidden` integer,
	`is_system` integer,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mutation_queue` (
	`mutation_id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_guuid` text NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`expected_row_version` integer,
	`client_modified_at` text NOT NULL,
	`parent_guuid` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`server_row` text,
	`first_failure_at` text,
	`last_failure_at` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`kind` text,
	`sort_order` integer,
	`is_system` integer,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`product_fk` text NOT NULL,
	`name` text NOT NULL,
	`quantity` text NOT NULL,
	`barcode` text,
	`selling_price` text,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`name` text NOT NULL,
	`sku` text,
	`barcode` text,
	`category_lookup_fk` text,
	`unit_fk` text,
	`taxrate_fk` text,
	`selling_price` text NOT NULL,
	`cost_price` text,
	`mrp` text,
	`hsn_code` text,
	`track_inventory` integer,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`migrated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`guuid` text NOT NULL,
	`store_id` text NOT NULL,
	`name` text NOT NULL,
	`gst_number` text,
	`address` text,
	`phone` text,
	`email` text,
	`invoice_prefix` text,
	`is_active` integer,
	`locked` integer,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`store_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_init_progress` (
	`store_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`cursor` text,
	`phase` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`store_id`, `entity_type`)
);
--> statement-breakpoint
CREATE TABLE `tax_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`name` text NOT NULL,
	`rate_percent` text NOT NULL,
	`is_inclusive` integer,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`name` text NOT NULL,
	`abbreviation` text,
	`allows_fractions` integer,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
