// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "eslint.config.js"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Fire-and-forget promises must be explicit (`void fn()`), not accidental.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
    },
  },
  {
    // node:test's test() returns a promise the runner itself awaits; test stubs
    // are often async without awaiting (fakes, thrown errors).
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);
