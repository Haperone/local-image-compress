"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const esbuildCli = require.resolve("esbuild/bin/esbuild");
const production = process.argv.includes("--production");
const generatedBanner = "/* GENERATED/BUNDLED FILE. Review source at https://github.com/haperone/local-image-compress */";

function runEsbuildCli(args) {
  childProcess.execFileSync(process.execPath, [esbuildCli, ...args], {
    cwd: root,
    stdio: "inherit"
  });
}

function buildWithCliFallback() {
  const tempDir = path.join(root, "dist-ts", ".build");
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
      ...(production ? ["--minify"] : []),
      "--log-level=silent"
    ]);

    const compressionWorkerSource = fs.readFileSync(workerBundlePath, "utf8");
    fs.writeFileSync(workerSourceModulePath, `export default ${JSON.stringify(compressionWorkerSource)};\n`);

    runEsbuildCli([
      path.join("src-ts", "main.ts"),
      "--bundle",
      "--platform=node",
      "--target=es2020",
      "--format=cjs",
      "--loader:.wasm=binary",
      "--external:obsidian",
      "--external:electron",
      `--alias:virtual:compression-worker=./${path.relative(root, workerSourceModulePath).replace(/\\/g, "/")}`,
      `--outfile=${path.join(root, "dist-ts", "main.js")}`,
      `--banner:js=${generatedBanner}`,
      ...(production ? ["--minify"] : []),
      "--log-level=info"
    ]);
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
    minify: production,
    loader: {
      ".wasm": "binary"
    },
    logLevel: "silent"
  });
  const compressionWorkerSource = Buffer.from(workerResult.outputFiles[0].contents).toString("utf8");

  await esbuild.build({
    entryPoints: [path.join(root, "src-ts", "main.ts")],
    outfile: path.join(root, "dist-ts", "main.js"),
    bundle: true,
    platform: "node",
    target: "es2020",
    format: "cjs",
    sourcemap: false,
    minify: production,
    banner: {
      js: generatedBanner
    },
    loader: {
      ".wasm": "binary"
    },
    external: [
      "obsidian",
      "electron"
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
  process.stdout.write(`Building ${production ? "production minified" : "review"} bundle...\n`);
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
