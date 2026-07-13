CREATE TABLE `payment_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`name` text NOT NULL,
	`payment_method_fk` text,
	`details` text,
	`is_default` integer,
	`is_active` integer,
	`is_system` integer,
	`system_key` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
