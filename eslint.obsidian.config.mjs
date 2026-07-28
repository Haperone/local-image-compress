// Blocking mirror of the current Obsidian community-plugin submission scanner.
import fs from "node:fs";
import path from "node:path";
import json from "@eslint/json";
import tsParser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

const isDevLayout = path.basename(import.meta.dirname) === "source-recovery"
  && fs.existsSync(path.join(import.meta.dirname, "src-ts"))
  && fs.existsSync(path.join(import.meta.dirname, "..", "manifest.json"));
const sourcePrefix = isDevLayout ? "source-recovery/" : "";
const sourceFiles = [`${sourcePrefix}src-ts/**/*.ts`];
const disabledObsidianJsonRules = Object.fromEntries(
  Object.keys(obsidianmd.rules).map((ruleName) => [`obsidianmd/${ruleName}`, "off"])
);

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
      globals: {
        __LIC_MOBILE_QA__: "readonly",
        __LIC_MOBILE_QA_FINGERPRINT__: "readonly"
      },
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        sourceType: "module"
      }
    }
  },
  {
    // The desktop platform port lazy-requires Node/Electron inside functions
    // so the shared bundle can load on mobile; top-level imports would crash
    // there. validate-manifest.js confines these requires to this one file,
    // and none of them execute on mobile code paths.
    files: [`${sourcePrefix}src-ts/platform/desktop.ts`],
    languageOptions: {
      globals: {
        require: "readonly",
        process: "readonly",
        Buffer: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "import/no-nodejs-modules": "off"
    }
  },
  {
    // Mobile QA hard-deletes only its marker-verified synthetic session root.
    // Moving that tree to trash would escape the ownership boundary and retain fixtures.
    files: [`${sourcePrefix}src-ts/qa/session.ts`],
    rules: {
      "obsidianmd/prefer-file-manager-trash-file": "off"
    }
  },
  {
    files: [`${sourcePrefix}src-ts/locales/en.json`],
    plugins: { json },
    language: "json/json",
    rules: {
      ...disabledObsidianJsonRules,
      "no-irregular-whitespace": "off",
      "obsidianmd/ui/sentence-case-json": "error"
    }
  }
];
