"use strict";

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const { computeMobileQaSourceFingerprint } = require("./mobile-qa-fingerprint");
const { resolveRepositoryLayout } = require("./repository-layout");
const { runEsbuildCli } = require("./run-esbuild-cli");

const { isDevLayout, repositoryRoot, sourceRoot: root } = resolveRepositoryLayout();
const production = process.argv.includes("--production");
const mobileQa = process.argv.includes("--qa");
const forceCli = process.argv.includes("--force-cli");
if (production && mobileQa) {
  throw new Error("--production and --qa are mutually exclusive build profiles");
}
const outputDirectory = mobileQa ? path.join(repositoryRoot, "mobile-qa-build") : path.join(root, "dist-ts");
const generatedWorkerPath = mobileQa ? null : path.join(outputDirectory, "compression-worker.js");
const mainBundlePath = path.join(outputDirectory, "main.js");
const minify = production || mobileQa;
const sourceRepositoryUrl = isDevLayout
  ? "https://github.com/haperone/local-image-compress_DEV"
  : "https://github.com/haperone/local-image-compress";
const generatedBanner = mobileQa
  ? `/* GENERATED MOBILE QA BUNDLE. LIC_MOBILE_QA_BUILD_V1. Review source at ${sourceRepositoryUrl} */`
  : `/* GENERATED/BUNDLED FILE. Review source at ${sourceRepositoryUrl} */`;

const mobileQaSourceFingerprint = mobileQa ? computeMobileQaSourceFingerprint() : "production";

function buildWithCliFallback() {
  const tempDir = path.join(outputDirectory, ".build");
  const workerBundlePath = path.join(tempDir, "compression-worker.js");
  const workerSourceModulePath = path.join(tempDir, "compression-worker-source.js");

  fs.mkdirSync(tempDir, { recursive: true });
  try {
    runEsbuildCli([
      path.join("src-ts", "compression-worker.ts"),
      "--bundle",
      "--platform=browser",
      "--target=es2020",
      "--format=iife",
      "--loader:.wasm=binary",
      `--outfile=${workerBundlePath}`,
      ...(minify ? ["--minify"] : []),
      "--log-level=silent"
    ], { cwd: root, stdio: "inherit" });

    const compressionWorkerSource = fs.readFileSync(workerBundlePath, "utf8");
    if (generatedWorkerPath) {
      fs.copyFileSync(workerBundlePath, generatedWorkerPath);
    }
    fs.writeFileSync(workerSourceModulePath, `export default ${JSON.stringify(compressionWorkerSource)};\n`);

    runEsbuildCli([
      path.join("src-ts", "main.ts"),
      "--bundle",
      "--platform=browser",
      "--target=es2020",
      "--format=cjs",
      "--loader:.wasm=binary",
      "--external:obsidian",
      "--external:electron",
      "--external:buffer",
      "--external:fs",
      "--external:path",
      "--external:crypto",
      "--external:stream/promises",
      `--alias:virtual:compression-worker=./${path.relative(root, workerSourceModulePath).replace(/\\/g, "/")}`,
      `--outfile=${mainBundlePath}`,
      `--banner:js=${generatedBanner}`,
      `--define:__LIC_MOBILE_QA__=${mobileQa ? "true" : "false"}`,
      `--define:__LIC_MOBILE_QA_FINGERPRINT__=${JSON.stringify(mobileQaSourceFingerprint)}`,
      ...(minify ? ["--minify"] : []),
      "--log-level=info"
    ], { cwd: root, stdio: "inherit" });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function buildWithApi() {
  const workerResult = await esbuild.build({
    entryPoints: [path.join(root, "src-ts", "compression-worker.ts")],
    bundle: true,
    platform: "browser",
    target: "es2020",
    format: "iife",
    write: false,
    sourcemap: false,
    minify,
    loader: {
      ".wasm": "binary"
    },
    logLevel: "silent"
  });
  const compressionWorkerSource = Buffer.from(workerResult.outputFiles[0].contents).toString("utf8");
  if (generatedWorkerPath) {
    fs.mkdirSync(path.dirname(generatedWorkerPath), { recursive: true });
    fs.writeFileSync(generatedWorkerPath, compressionWorkerSource);
  }

  await esbuild.build({
    entryPoints: [path.join(root, "src-ts", "main.ts")],
    outfile: mainBundlePath,
    bundle: true,
    platform: "browser",
    target: "es2020",
    format: "cjs",
    sourcemap: false,
    minify,
    define: {
      __LIC_MOBILE_QA__: mobileQa ? "true" : "false",
      __LIC_MOBILE_QA_FINGERPRINT__: JSON.stringify(mobileQaSourceFingerprint)
    },
    banner: {
      js: generatedBanner
    },
    loader: {
      ".wasm": "binary"
    },
    external: [
      "obsidian",
      "electron",
      "buffer",
      "fs",
      "path",
      "crypto",
      "stream/promises"
    ],
    plugins: [
      {
        name: "compression-worker-source",
        setup(build) {
          build.onResolve({ filter: /^virtual:compression-worker$/ }, (args) => ({
            path: args.path,
            namespace: "compression-worker-source"
          }));
          build.onLoad({ filter: /.*/, namespace: "compression-worker-source" }, () => ({
            contents: `export default ${JSON.stringify(compressionWorkerSource)};`,
            loader: "js"
          }));
        }
      }
    ],
    logLevel: "info"
  });
}

async function main() {
  const profile = production ? "production minified" : mobileQa ? "mobile QA minified" : "review";
  process.stdout.write(`Building ${profile} bundle...\n`);
  if (mobileQa) {
    process.stdout.write(`Mobile QA source fingerprint: ${mobileQaSourceFingerprint}\n`);
  }
  if (forceCli) {
    buildWithCliFallback();
    return;
  }
  try {
    await buildWithApi();
  } catch (error) {
    if (error?.code !== "EPERM") {
      throw error;
    }
    console.warn("esbuild JS API spawn failed with EPERM; falling back to esbuild CLI.");
    buildWithCliFallback();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
