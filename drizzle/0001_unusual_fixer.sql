PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_job_ads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position` text NOT NULL,
	`status` integer DEFAULT 0,
	`emailLetter` text,
	`companyDesc` text NOT NULL,
	`companyName` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_job_ads`("id", "position", "status", "emailLetter", "companyDesc", "companyName") SELECT "id", "position", "status", "emailLetter", "companyDesc", "companyName" FROM `job_ads`;--> statement-breakpoint
DROP TABLE `job_ads`;--> statement-breakpoint
ALTER TABLE `__new_job_ads` RENAME TO `job_ads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;