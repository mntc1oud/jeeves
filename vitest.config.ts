import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(__dirname, "drizzle");
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          kvNamespaces: ["JEEVES_STATE"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            TG_ENABLE_API: false,
          },
        },
      };
    }),
  ],
});
