"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot } = resolveRepositoryLayout(__dirname);
const outputPath = path.join(repositoryRoot, "release-notes.md");

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

const commitMessage = gitOutput(["log", "-1", "--format=%B", "HEAD"]).replace(/\r\n/g, "\n").trimEnd();
const [, ...bodyLines] = commitMessage.split("\n");
const notes = bodyLines.join("\n").trim();
if (!notes) {
  throw new Error("Release commit message has no promoted DEV subjects; create the PROD commit with npm run prod:commit");
}

fs.writeFileSync(outputPath, `${notes}\n`);
process.stdout.write(`Prepared GitHub release notes from the release commit body: ${outputPath}\n`);
