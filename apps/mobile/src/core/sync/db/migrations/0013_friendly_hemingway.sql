CREATE TABLE `account_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`account_fk` text NOT NULL,
	`direction` text,
	`amount_paise` integer NOT NULL,
	`reason` text,
	`source_type` text,
	`source_fk` text,
	`shift_session_fk` text,
	`note` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`guuid` text NOT NULL,
	`account_fk` text NOT NULL,
	`type` text,
	`reason` text,
	`amount_paise` integer NOT NULL,
	`by_user_fk` text,
	`row_version` integer NOT NULL,
	`modified_at` text NOT NULL
);
