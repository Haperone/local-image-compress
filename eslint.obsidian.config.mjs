// Blocking mirror of the current Obsidian community-plugin submission scanner.
import fs from "node:fs";
import path from "node:path";
import tsParser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

const isDevLayout = path.basename(import.meta.dirname) === "source-recovery"
  && fs.existsSync(path.join(import.meta.dirname, "src-ts"))
  && fs.existsSync(path.join(import.meta.dirname, "..", "manifest.json"));
const sourcePrefix = isDevLayout ? "source-recovery/" : "";
const sourceFiles = [`${sourcePrefix}src-ts/**/*.ts`];

export default [
  {
    ignores: [
      `${sourcePrefix}node_modules/**`,
      `${sourcePrefix}dist/**`,
      `${sourcePrefix}dist-ts/**`,
      `${sourcePrefix}qa-backups/**`,
      `${sourcePrefix}qa-screenshots/**`,
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
    files: [`${sourcePrefix}src-ts/i18n.ts`],
    rules: {
      "obsidianmd/ui/sentence-case-locale-module": "error"
    }
  }
];
