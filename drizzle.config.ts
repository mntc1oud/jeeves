import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./workers/bot/db_schema.ts",
  dialect: "sqlite",
});
