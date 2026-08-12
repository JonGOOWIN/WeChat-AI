import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceRules = {
  ...js.configs.recommended.rules,
  // TypeScript performs these checks with type-aware semantics.
  "no-undef": "off",
  "no-unused-vars": "off",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.wrangler/**",
      "apps/api/public/**",
      "cloudflare-worker/worker.js",
      "huggingface/**",
      "scripts/fixtures/**",
      "scripts/ui-shots/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["*.{js,mjs,cjs}", "scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.node,
    },
    rules: sourceRules,
  },
  {
    files: ["cloudflare-worker/src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.serviceworker,
    },
    rules: sourceRules,
  },
];
