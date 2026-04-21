CREATE TABLE `job_ads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position` text NOT NULL,
	`status` integer,
	`emailLetter` text,
	`companyDesc` text NOT NULL,
	`companyName` text NOT NULL
);
