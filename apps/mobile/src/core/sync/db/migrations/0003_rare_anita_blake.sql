CREATE TABLE `sync_store_meta` (
	`store_id` text PRIMARY KEY NOT NULL,
	`permissions_version` integer,
	`updated_at` text NOT NULL
);
