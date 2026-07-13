CREATE TABLE `attachment` (
	`guuid` text PRIMARY KEY NOT NULL,
	`store_fk` text NOT NULL,
	`entity_type` text NOT NULL,
	`record_guuid` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending_upload' NOT NULL,
	`local_path` text,
	`local_thumb_path` text,
	`file_guuid` text,
	`temp_guuid` text,
	`mime_type` text,
	`size_bytes` integer,
	`sha256` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`defer_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`last_error_code` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_att_pending` ON `attachment` (`status`,`next_attempt_at`) WHERE "attachment"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_att_parent` ON `attachment` (`record_guuid`) WHERE "attachment"."deleted_at" IS NULL;