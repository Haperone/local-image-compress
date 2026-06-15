"use strict";

const fs = require("fs");
const path = require("path");

function resolveRepositoryLayout(scriptDirectory = __dirname) {
  const sourceRoot = path.resolve(scriptDirectory, "..");
  const parentRoot = path.resolve(sourceRoot, "..");
  const isDevLayout = path.basename(sourceRoot) === "source-recovery"
    && fs.existsSync(path.join(sourceRoot, "src-ts"))
    && fs.existsSync(path.join(parentRoot, "manifest.json"));
  const repositoryRoot = isDevLayout ? parentRoot : sourceRoot;
  return {
    isDevLayout,
    repositoryRoot,
    sourceRoot
  };
}

module.exports = {
  resolveRepositoryLayout
};
