import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: { TEST_MIGRATIONS: migrations, ENABLE_RECEIPT_EVAL: "0" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
