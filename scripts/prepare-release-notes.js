"use strict";

const fs = require("fs");
const path = require("path");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot } = resolveRepositoryLayout(__dirname);
const changelogPath = path.join(repositoryRoot, "CHANGELOG.md");
const outputPath = path.join(repositoryRoot, "release-notes.md");

if (!fs.existsSync(changelogPath)) {
  throw new Error("CHANGELOG.md is missing; run DEV to PROD promotion before creating a release");
}

const changelog = fs.readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
const heading = "## Unreleased";
const headingIndex = changelog.indexOf(heading);
const contentStart = headingIndex < 0 ? -1 : changelog.indexOf("\n", headingIndex) + 1;
const nextSection = contentStart <= 0 ? -1 : changelog.indexOf("\n## ", contentStart);
const notes = contentStart <= 0 ? "" : changelog.slice(contentStart, nextSection < 0 ? changelog.length : nextSection).trim();
if (!notes || notes.includes("_No changes._")) {
  throw new Error("CHANGELOG.md has no unreleased changes");
}

fs.writeFileSync(outputPath, `${notes}\n`);
process.stdout.write(`Prepared GitHub release notes from CHANGELOG.md: ${outputPath}\n`);
