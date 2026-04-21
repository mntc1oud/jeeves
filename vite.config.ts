import { defineConfig } from "vite";

import { preact } from "@preact/preset-vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    preact(),
    cloudflare({
      auxiliaryWorkers: [
        {
          config: {
            name: "plushkin",
            main: "./workers/plushkin/index.ts",
            compatibility_flags: ["nodejs_compat"],
          },
        },
      ],
    }),
  ],
});
