const path = require("path");

async function main() {
  const repositoryRoot = path.resolve(__dirname, "..");
  process.chdir(repositoryRoot);
  const { ESLint } = require("eslint");
  const eslint = new ESLint({
    cwd: repositoryRoot,
    overrideConfigFile: path.join(repositoryRoot, "eslint.obsidian.config.mjs"),
    fix: process.argv.includes("--fix")
  });
  const results = await eslint.lintFiles(["src-ts/"]);
  await ESLint.outputFixes(results);
  const formatter = await eslint.loadFormatter("stylish");
  const output = formatter.format(results);
  if (output) {
    process.stdout.write(output);
  }
  const errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
  const warningCount = results.reduce((sum, result) => sum + result.warningCount, 0);
  if (errorCount === 0 && warningCount === 0) {
    process.stdout.write(`Obsidian lint passed: ${results.length} files, 0 errors, 0 warnings.\n`);
  }
  process.exitCode = errorCount === 0 && warningCount === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
