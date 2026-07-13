CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`email` text,
	`gst_number` text,
	`is_active` integer,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
