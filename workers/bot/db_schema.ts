import { sql } from "drizzle-orm";
import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const enum Status {
  InProgress,
  Rejected,
  Invited,
}

export const jobsTable = sqliteTable("job_ads", {
  id: int().primaryKey({ autoIncrement: true }),
  position: text().notNull(),
  status: int().$type<Status>().default(Status.InProgress),
  emailLetter: text(),
  companyDesc: text().notNull(),
  companyName: text().notNull(),
  createdAt: text().default(sql`(CURRENT_TIMESTAMP)`)
});
