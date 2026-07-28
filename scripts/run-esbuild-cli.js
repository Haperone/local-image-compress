"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");

const esbuildCli = require.resolve("esbuild/bin/esbuild");
const prefix = Buffer.alloc(2);
const descriptor = fs.openSync(esbuildCli, "r");
try {
  fs.readSync(descriptor, prefix, 0, prefix.length, 0);
} finally {
  fs.closeSync(descriptor);
}
const isJavaScriptLauncher = prefix[0] === 0x23 && prefix[1] === 0x21;

function runEsbuildCli(args, options) {
  return childProcess.execFileSync(
    isJavaScriptLauncher ? process.execPath : esbuildCli,
    isJavaScriptLauncher ? [esbuildCli, ...args] : args,
    options
  );
}

module.exports = { runEsbuildCli };
