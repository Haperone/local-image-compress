// Blocking mirror of the current Obsidian community-plugin submission scanner.
import tsParser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

const sourceFiles = ["src-ts/**/*.ts"];

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-ts/**",
      "qa-backups/**",
      "qa-screenshots/**",
      "**/.claude/**",
      "**/.supergoal/**",
      "*.mjs"
    ]
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: sourceFiles
  })),
  ...obsidianmd.configs.recommendedWithLocalesEn,
  {
    files: sourceFiles,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        sourceType: "module"
      }
    }
  },
  {
    files: ["src-ts/i18n.ts"],
    rules: {
      "obsidianmd/ui/sentence-case-locale-module": "error"
    }
  }
];
