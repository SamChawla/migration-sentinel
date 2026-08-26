import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    globals: false,
    // Integration tests self-skip when SHADOW_DATABASE_URL is unset.
    testTimeout: 20000,
  },
});
