"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { resolveRepositoryLayout } = require("./repository-layout");

const { sourceRoot: root } = resolveRepositoryLayout();

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) {
    return bytes.slice(0);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function createImageData(width, height, mode) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = mode === "blocks" ? (Math.floor(x / 8) % 2 ? 220 : 30) : (x * 5 + y) & 255;
      data[offset + 1] = mode === "blocks" ? (Math.floor(y / 8) % 2 ? 190 : 45) : (y * 7 + x) & 255;
      data[offset + 2] = mode === "blocks" ? 100 : (x * 3 + y * 11) & 255;
      data[offset + 3] = 255;
    }
  }
  return new global.ImageData(data, width, height);
}

async function createInputs() {
  global.ImageData ??= class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  const [jpegEncoder, pngEncoder] = await Promise.all([
    import("@jsquash/jpeg/encode.js"),
    import("@jsquash/png/encode.js")
  ]);
  await jpegEncoder.init(new WebAssembly.Module(fs.readFileSync(path.join(root, "node_modules", "@jsquash", "jpeg", "codec", "enc", "mozjpeg_enc.wasm"))), { locateFile: (name) => name });
  await pngEncoder.init(fs.readFileSync(path.join(root, "node_modules", "@jsquash", "png", "codec", "pkg", "squoosh_png_bg.wasm")));
  return {
    jpeg: toArrayBuffer(await jpegEncoder.default(createImageData(96, 96, "gradient"), { quality: 95 })),
    png: toArrayBuffer(await pngEncoder.default(createImageData(160, 120, "blocks")))
  };
}

async function main() {
  global.ImageData ??= class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  const generatedWorkerPath = path.join(root, "dist-ts", "compression-worker.js");
  assert(fs.existsSync(generatedWorkerPath), "Generated compression worker is missing; run build:ts first");
  const generatedWorkerSource = fs.readFileSync(generatedWorkerPath, "utf8");
  const replies = [];
  const workerWarnings = [];
  const waiters = new Map();
  const workerGlobal = {
    ArrayBuffer,
    Uint8Array,
    Uint8ClampedArray,
    DataView,
    TextDecoder,
    TextEncoder,
    ImageData: global.ImageData,
    WebAssembly,
    Promise,
    Error,
    TypeError,
    console: {
      ...console,
      warn: (...args) => workerWarnings.push(args.map(String).join(" "))
    },
    setTimeout,
    clearTimeout,
    structuredClone,
    postMessage(message) {
      replies.push(message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    },
    onmessage: null
  };
  workerGlobal.self = workerGlobal;
  workerGlobal.globalThis = workerGlobal;
  vm.runInContext(generatedWorkerSource, vm.createContext(workerGlobal), {
    filename: "compression-worker.browser.js"
  });

  const send = async (message) => await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker reply timed out for ${message.type}`)), 30000);
    waiters.set(message.id, (reply) => {
      clearTimeout(timeout);
      resolve(reply);
    });
    workerGlobal.onmessage({ data: message });
  });
  const wasm = {
    jpegDecode: toArrayBuffer(fs.readFileSync(path.join(root, "node_modules", "@jsquash", "jpeg", "codec", "dec", "mozjpeg_dec.wasm"))),
    jpegEncode: toArrayBuffer(fs.readFileSync(path.join(root, "node_modules", "@jsquash", "jpeg", "codec", "enc", "mozjpeg_enc.wasm"))),
    png: toArrayBuffer(fs.readFileSync(path.join(root, "node_modules", "@jsquash", "png", "codec", "pkg", "squoosh_png_bg.wasm"))),
    imagequant: toArrayBuffer(fs.readFileSync(path.join(root, "node_modules", "imagequant", "imagequant_bg.wasm")))
  };
  const ready = await send({ id: 1, type: "init", wasm });
  assert.equal(ready.type, "ready", `Generated worker bundle WASM init failed: ${JSON.stringify(ready)}`);

  const inputs = await createInputs();
  const settings = { jpegQuality: 40, pngQuality: { min: 1, max: 100 } };
  const jpeg = await send({ id: 2, type: "compress", format: "jpeg", buffer: inputs.jpeg, settings });
  assert(jpeg.ok === true && new Uint8Array(jpeg.output)[0] === 0xff && new Uint8Array(jpeg.output)[1] === 0xd8, `Generated JPEG worker bundle path failed: ${JSON.stringify(jpeg)}`);
  const png = await send({ id: 3, type: "compress", format: "png", buffer: inputs.png, settings });
  const pngBytes = new Uint8Array(png.output || new ArrayBuffer(0));
  assert(png.ok === true && pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47, `Generated PNG worker bundle path failed: ${JSON.stringify(png)}`);
  assert(replies.length === 3, `Unexpected generated worker bundle reply count: ${replies.length}`);
  assert(workerWarnings.length === 0, `Generated worker bundle emitted warnings: ${workerWarnings.join(" | ")}`);
  console.log("Generated worker codec VM verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
