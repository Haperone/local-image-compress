import jpegDecode, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import jpegEncode, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import pngDecode, { init as initPngDecode } from "@jsquash/png/decode.js";
import * as imagequantBindings from "imagequant/imagequant_bg.js";
import { validateEncodedOutputFormat } from "./encoded-output-validator";

type WorkerInitMessage = {
  id: number;
  type: "init";
  wasm: {
    jpegDecode: ArrayBuffer;
    jpegEncode: ArrayBuffer;
    png: ArrayBuffer;
    imagequant: ArrayBuffer;
  };
};

type WorkerCompressMessage = {
  id: number;
  type: "compress";
  format: "png" | "jpeg";
  buffer: ArrayBuffer;
  settings: {
    pngQuality: { min: number; max: number };
    jpegQuality: number;
  };
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
type ImagequantConstructor = new (...args: never[]) => {
  set_quality(min: number, max: number): void;
  set_speed(speed: number): void;
  process(image: unknown): Uint8Array;
  free(): void;
};
type ImagequantImageConstructor = new (data: Uint8Array, width: number, height: number, gamma: number) => {
  free(): void;
};
type ImagequantBindingModule = typeof imagequantBindings & {
  __wbg_set_wasm(exports: WebAssembly.Exports): void;
  Imagequant: ImagequantConstructor;
  ImagequantImage: ImagequantImageConstructor;
};
type WasmInstantiateResult = WebAssembly.WebAssemblyInstantiatedSource | {
  instance?: { exports?: WebAssembly.Exports };
  exports?: WebAssembly.Exports;
};

let initialized = false;
let imagequantSmokeValidated = false;
let jpegDecodeModule: WebAssembly.Module | null = null;
let jpegEncodeModule: WebAssembly.Module | null = null;
const workerScope = self as unknown as WorkerScope;

const REQUIRED_IMAGEQUANT_FUNCTION_EXPORTS = [
  "__wbg_imagequant_free",
  "__wbg_imagequantimage_free",
  "__wbindgen_add_to_stack_pointer",
  "__wbindgen_free",
  "__wbindgen_malloc",
  "imagequant_new",
  "imagequant_new_image",
  "imagequant_process",
  "imagequant_set_quality",
  "imagequant_set_speed",
  "imagequantimage_new"
];

function formatWorkerError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" && error ? error : "unknown error";
}

function isPngQualityFailure(error: unknown) {
  if (error instanceof PngQualityFailureError) {
    return true;
  }
  return false;
}

function isImagequantQualityError(error: unknown) {
  const message = formatWorkerError(error).toLowerCase();
  return message.includes("quality_too_low") || message.includes("quality too low") || message.includes("minimum quality");
}

function isJpegEncodingFailureMessage(message: string) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("mozjpeg") || normalized.includes("jpeg encode");
}

class PngQualityFailureError extends Error {
  constructor(cause: unknown) {
    super(`PNG quality target could not be satisfied: ${formatWorkerError(cause)}`);
    this.name = "PngQualityFailureError";
  }
}

function toUint8Array(input: ArrayBuffer | Uint8Array | Uint8ClampedArray) {
  if (input instanceof Uint8Array && !(input instanceof Uint8ClampedArray)) {
    return input;
  }
  if (input instanceof Uint8ClampedArray) {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    return copy;
  }
  return new Uint8Array(input);
}

function toTransferableArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) {
    return input.buffer as ArrayBuffer;
  }
  const output = new ArrayBuffer(input.byteLength);
  new Uint8Array(output).set(input);
  return output;
}

function validateEncodedOutput(format: WorkerCompressMessage["format"], output: ArrayBuffer | Uint8Array) {
  validateEncodedOutputFormat(format, output);
}

function getCachedWasmModule(cacheKey: "jpegDecode" | "jpegEncode", bytes: ArrayBuffer) {
  if (cacheKey === "jpegDecode") {
    jpegDecodeModule = jpegDecodeModule || new WebAssembly.Module(bytes);
    return jpegDecodeModule;
  }
  jpegEncodeModule = jpegEncodeModule || new WebAssembly.Module(bytes);
  return jpegEncodeModule;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function isFiniteMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWorkerInitMessage(message: unknown): message is WorkerInitMessage {
  if (!isPlainRecord(message)) {
    return false;
  }
  const id = message["id"];
  const type = message["type"];
  const wasm = message["wasm"];
  if (!isFiniteMessageId(id) || type !== "init" || !isPlainRecord(wasm)) {
    return false;
  }
  return isArrayBuffer(wasm["jpegDecode"]) &&
    isArrayBuffer(wasm["jpegEncode"]) &&
    isArrayBuffer(wasm["png"]) &&
    isArrayBuffer(wasm["imagequant"]);
}

function isWorkerCompressMessage(message: unknown): message is WorkerCompressMessage {
  if (!isPlainRecord(message)) {
    return false;
  }
  const id = message["id"];
  const type = message["type"];
  const format = message["format"];
  if (!isFiniteMessageId(id) || type !== "compress") {
    return false;
  }
  if (format !== "png" && format !== "jpeg") {
    return false;
  }
  return isArrayBuffer(message["buffer"]) && isPlainRecord(message["settings"]);
}

function postWorkerFailure(id: number, kind: string, message: string, skipReason?: string) {
  workerScope.postMessage({
    id,
    type: "result",
    ok: false,
    error: { kind, message, skipReason }
  });
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(max, integer));
}

function validateImagequantBindings(bindings: unknown) {
  const candidate = bindings as {
    __wbg_set_wasm?: unknown;
    Imagequant?: unknown;
    ImagequantImage?: unknown;
  };
  if (typeof candidate.__wbg_set_wasm !== "function") {
    throw new Error("Invalid imagequant bindings: __wbg_set_wasm missing");
  }
  if (typeof candidate.Imagequant !== "function" || typeof candidate.ImagequantImage !== "function") {
    throw new Error("Invalid imagequant bindings: wrapper classes missing");
  }
}

function getImagequantBindingModule(): ImagequantBindingModule {
  validateImagequantBindings(imagequantBindings);
  return imagequantBindings;
}

function getImagequantExports(instanceResult: WasmInstantiateResult): WebAssembly.Exports {
  const directExports = "exports" in instanceResult ? instanceResult.exports : undefined;
  const exports = instanceResult.instance?.exports || directExports;
  if (!exports || typeof exports !== "object") {
    throw new Error("Invalid imagequant WASM module: exports missing");
  }
  return exports;
}

function validateImagequantExports(exports: WebAssembly.Exports) {
  const memory = exports["memory"];
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Invalid imagequant WASM module: missing memory export");
  }
  for (const exportName of REQUIRED_IMAGEQUANT_FUNCTION_EXPORTS) {
    if (typeof exports[exportName] !== "function") {
      throw new Error(`Invalid imagequant WASM module: missing ${exportName} export`);
    }
  }
}

async function initializeCodecs(message: WorkerInitMessage) {
  const locateFile = (fileName: string) => fileName;
  let initStage = "jpeg-decode";
  initialized = false;
  imagequantSmokeValidated = false;
  try {
    await initJpegDecode(getCachedWasmModule("jpegDecode", message.wasm.jpegDecode), { locateFile });
    initStage = "jpeg-encode";
    await initJpegEncode(getCachedWasmModule("jpegEncode", message.wasm.jpegEncode), { locateFile });
    initStage = "png";
    await initPngDecode(message.wasm.png);
    initStage = "imagequant";

    const imagequantWasmInstance = await WebAssembly.instantiate(message.wasm.imagequant, {
      "./imagequant_bg.js": imagequantBindings
    }) as WasmInstantiateResult;
    const imagequantModule = getImagequantBindingModule();
    const imagequantExports = getImagequantExports(imagequantWasmInstance);
    validateImagequantExports(imagequantExports);
    imagequantModule.__wbg_set_wasm(imagequantExports);
    initStage = "complete";
    initialized = true;
  } catch (error) {
    initialized = false;
    throw new Error(`WASM init failed at stage ${initStage}: ${formatWorkerError(error)}`);
  }
}

function validateImagequantRuntimeSmoke() {
  if (imagequantSmokeValidated) {
    return;
  }
  const { Imagequant } = getImagequantBindingModule();
  const smokeQuantizer = new Imagequant();
  try {
    smokeQuantizer.set_quality(0, 100);
    imagequantSmokeValidated = true;
  } finally {
    try {
      smokeQuantizer.free();
    } catch (error) {
      console.warn("[CompressionWorker]", "Imagequant smoke quantizer cleanup failed:", error);
    }
  }
}

function quantizePngToPng(imageData: ImageData, settings: WorkerCompressMessage["settings"]) {
  validateImagequantRuntimeSmoke();
  const imagequantModule = getImagequantBindingModule();
  const Imagequant = imagequantModule.Imagequant;
  const ImagequantImage = imagequantModule.ImagequantImage;
  const quantizer = new Imagequant();
  let image: InstanceType<ImagequantImageConstructor> | null = null;
  try {
    const safeMin = clampInteger(settings.pngQuality?.min, 65, 1, 100);
    const safeMax = Math.max(safeMin, clampInteger(settings.pngQuality?.max, 80, 1, 100));
    quantizer.set_quality(safeMin, safeMax);
    quantizer.set_speed(6);
    image = new ImagequantImage(toUint8Array(imageData.data), imageData.width, imageData.height, 0);
    return quantizer.process(image);
  } catch (error) {
    if (isImagequantQualityError(error)) {
      throw new PngQualityFailureError(error);
    }
    throw error;
  } finally {
    try {
      image?.free?.();
    } catch (error) {
      console.warn("[CompressionWorker]", "Imagequant image cleanup failed:", error);
    }
    try {
      quantizer.free();
    } catch (error) {
      console.warn("[CompressionWorker]", "Imagequant quantizer cleanup failed:", error);
    }
  }
}

async function compressInWorker(message: WorkerCompressMessage) {
  if (!initialized) {
    throw new Error("Worker codecs are not initialized");
  }
  if (message.format === "png") {
    const decoded = await pngDecode(message.buffer);
    const output = toTransferableArrayBuffer(quantizePngToPng(decoded, message.settings));
    validateEncodedOutput(message.format, output);
    return output;
  }
  const decoded = await jpegDecode(message.buffer);
  const output = toTransferableArrayBuffer(await jpegEncode(decoded, { quality: clampInteger(message.settings.jpegQuality, 85, 1, 95) }));
  validateEncodedOutput(message.format, output);
  return output;
}

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isPlainRecord(message)) {
    console.warn("[CompressionWorker]", "Malformed worker message:", message);
    return;
  }
  const messageId = message["id"];
  const messageType = message["type"];
  if (!isFiniteMessageId(messageId)) {
    console.warn("[CompressionWorker]", "Malformed worker message:", message);
    return;
  }
  if (messageType === "init") {
    if (!isWorkerInitMessage(message)) {
      workerScope.postMessage({
        id: messageId,
        type: "init-failed",
        error: { kind: "invalid_init_message", message: "Malformed init message" }
      });
      return;
    }
    initializeCodecs(message)
      .then(() => {
        workerScope.postMessage({ id: message.id, type: "ready" });
      })
      .catch((error) => {
        workerScope.postMessage({
          id: message.id,
          type: "init-failed",
          error: { kind: "init_failed", message: formatWorkerError(error) }
        });
      });
    return;
  }
  if (!isWorkerCompressMessage(message)) {
    postWorkerFailure(messageId, "unknown_message_type", `Unknown or malformed message type: ${String(messageType)}`);
    return;
  }

  compressInWorker(message)
    .then((output) => {
      workerScope.postMessage({ id: message.id, type: "result", ok: true, output }, [output]);
    })
    .catch((error) => {
      const qualityFailed = message.format === "png" && isPngQualityFailure(error);
      const formattedError = formatWorkerError(error);
      const jpegEncodeFailed = !qualityFailed && message.format === "jpeg" && isJpegEncodingFailureMessage(formattedError);
      const corruptEncoderOutput = !qualityFailed && !jpegEncodeFailed && formattedError.startsWith("Invalid compressed output:");
      postWorkerFailure(
        message.id,
        qualityFailed ? "quality_failed" : jpegEncodeFailed ? "jpeg_encode_failed" : corruptEncoderOutput ? "corrupt_encoder_output" : "unknown",
        formattedError,
        qualityFailed ? "pngquant_quality_failed" : jpegEncodeFailed ? "mozjpeg_failed" : corruptEncoderOutput ? "corrupt_encoder_output" : undefined
      );
    });
};
