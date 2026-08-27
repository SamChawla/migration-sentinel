import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    globals: false,
    // Integration tests self-skip when SHADOW_DATABASE_URL is unset.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      // Coverage measures the DETERMINISTIC safety core (the unit-tested logic).
      // The web app is validated by tsc + the integration/smoke scripts, and the
      // network/DB clients (TrueForge/pg/CLI shells) are exercised live, not in
      // unit tests, so they are excluded to keep the number honest.
      include: [
        "packages/shadow/src/**",
        "packages/core/src/**",
        "packages/qodo/src/index.ts",
        "packages/agent/src/apply.ts",
        "packages/agent/src/generate.ts",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
