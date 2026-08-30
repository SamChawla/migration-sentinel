// Flat ESLint config. Correctness-focused, not a style/formatter — the repo
// keeps its own hand-tuned house style, so we lint for bugs and dead code and
// leave whitespace alone. `pnpm lint` runs this; `pnpm typecheck` covers types.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Build output, generated artifacts, and vendored code are never linted.
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/drizzle/**",
      "**/*.config.js",
      "**/*.config.ts",
      "**/*.config.mjs",
      "**/next-env.d.ts", // Next.js-generated, owns its own triple-slash refs
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The repo carries a few deliberate `eslint-disable no-console` directives
    // (audit sink, test-skip warning) anticipating a console rule we don't
    // enforce here — leave them intact rather than strip them as "unused".
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused code is a real smell — flag it, but let intentionally-unused
      // args/vars opt out with a leading underscore.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // `any` is used deliberately at the pg/JSON/SDK boundaries; typecheck and
      // the deterministic core carry the real guarantees, so this is off.
      "@typescript-eslint/no-explicit-any": "off",
      // Empty catch blocks are a deliberate degrade-to-safe pattern here
      // (TrueForge best-effort deny, probe fallbacks); require a comment isn't
      // worth the churn.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // The SQL lexer (blast/preflight/environment) uses terse, deliberate
      // comma-sequence and ternary-as-statement expressions, exhaustively
      // covered by the lexer test suites. Off rather than rewrite tested code.
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    // Tests reach into internals and stub freely — relax the noisiest rules.
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
