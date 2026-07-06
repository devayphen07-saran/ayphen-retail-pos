PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lookups` (
	`id` text NOT NULL,
	`store_id` text NOT NULL,
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
	`modified_at` text NOT NULL,
	PRIMARY KEY(`store_id`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_lookups`("id", "store_id", "guuid", "lookup_type_fk", "code", "label", "description", "sort_order", "is_hidden", "is_system", "is_active", "row_version", "modified_at") SELECT "id", "store_id", "guuid", "lookup_type_fk", "code", "label", "description", "sort_order", "is_hidden", "is_system", "is_active", "row_version", "modified_at" FROM `lookups`;--> statement-breakpoint
DROP TABLE `lookups`;--> statement-breakpoint
ALTER TABLE `__new_lookups` RENAME TO `lookups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;