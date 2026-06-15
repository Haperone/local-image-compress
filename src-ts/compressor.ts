import workerSource from "virtual:compression-worker";
import jpegDecodeWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import jpegEncodeWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";
import * as pngWasmModule from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import imagequantWasm from "imagequant/imagequant_bg.wasm";
import jpegPackage from "@jsquash/jpeg/package.json";
import pngPackage from "@jsquash/png/package.json";
import imagequantPackage from "imagequant/package.json";
import type { CompressionResult } from "./types";
import {
  getInternalWorkerPoolSize,
  INTERNAL_COMPRESSION_TIMEOUT_SECONDS,
  INTERNAL_MAX_IMAGE_PIXELS_MILLIONS,
  INTERNAL_MAX_INPUT_SIZE_MB,
  INTERNAL_MAX_WORKER_POOL_SIZE,
  INTERNAL_WASM_INIT_TIMEOUT_SECONDS,
  type LocalImageCompressSettings
} from "./settings";
import { t } from "./i18n";
import { validateEncodedOutputFormat } from "./encoded-output-validator";
import { getActiveWindowForApp, getLogTag, normalizeOutputFolder, normalizeVaultPathRoot, randomHexSuffix, sanitizeErrorForUser } from "./utils";
import { WorkerPool } from "./worker-pool";
import { WorkerCompressionError, type WasmBytes, type WorkerFactory, type WorkerFormat } from "./worker-slot";
import type { App, TFile } from "obsidian";

// The package ships a wasm-bindgen declaration, while esbuild's binary loader exposes default bytes.
const pngWasm = (pngWasmModule as unknown as { default: Uint8Array }).default;

export const PACKAGE_VERSIONS = {
  jpeg: jpegPackage.version,
  png: pngPackage.version,
  imagequant: imagequantPackage.version
};

type BinaryInput = ArrayBuffer | Uint8Array | Buffer;
type BinaryVault = {
  readBinary(file: TFile): Promise<BinaryInput>;
  adapter: WritableBinaryAdapter;
};
type FileWithOptionalVault = TFile & {
  vault?: BinaryVault;
};
type WritableBinaryAdapter = {
  exists?: (path: string) => Promise<boolean> | boolean;
  mkdir?: (path: string) => Promise<void> | void;
  writeBinary?: (path: string, data: ArrayBuffer) => Promise<void> | void;
  rename?: (oldPath: string, newPath: string) => Promise<void> | void;
  remove?: (path: string) => Promise<void> | void;
};
type ImageDimensions = {
  width: number;
  height: number;
};

export class Compressor {
  processTimeoutMs: number;
  initTimeoutMs: number;
  maxInputBytes: number;
  maxImagePixels: number;
  app: App | null;
  workerFactory: WorkerFactory | null;
  workerPool: WorkerPool;
  activeWorkerCount: number;
  wasmBytes: WasmBytes;

  constructor(settings: LocalImageCompressSettings, app: App | null = null, workerFactory: WorkerFactory | null = null) {
    this.processTimeoutMs = INTERNAL_COMPRESSION_TIMEOUT_SECONDS * 1000;
    this.initTimeoutMs = INTERNAL_WASM_INIT_TIMEOUT_SECONDS * 1000;
    this.maxInputBytes = INTERNAL_MAX_INPUT_SIZE_MB * 1024 * 1024;
    this.maxImagePixels = INTERNAL_MAX_IMAGE_PIXELS_MILLIONS * 1_000_000;
    this.app = app;
    this.workerFactory = workerFactory;
    this.activeWorkerCount = getInternalWorkerPoolSize(getActiveWindowForApp(this.app)?.navigator?.hardwareConcurrency);
    this.applySettings(settings);
    this.wasmBytes = {
      jpegDecode: jpegDecodeWasm,
      jpegEncode: jpegEncodeWasm,
      png: pngWasm,
      imagequant: imagequantWasm
    };
    this.workerPool = this.createWorkerPool(this.activeWorkerCount);
  }

  applySettings(settings: LocalImageCompressSettings) {
    void settings;
    this.processTimeoutMs = INTERNAL_COMPRESSION_TIMEOUT_SECONDS * 1000;
    this.initTimeoutMs = INTERNAL_WASM_INIT_TIMEOUT_SECONDS * 1000;
    this.maxInputBytes = INTERNAL_MAX_INPUT_SIZE_MB * 1024 * 1024;
    this.maxImagePixels = INTERNAL_MAX_IMAGE_PIXELS_MILLIONS * 1_000_000;
  }

  text(key: string, fallback: string): string {
    return this.app ? t(this.app, key) : fallback;
  }

  getSavingsPercentage(originalSize: number, compressedSize: number) {
    if (!Number.isFinite(originalSize) || originalSize <= 0 || !Number.isFinite(compressedSize) || compressedSize < 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(((originalSize - compressedSize) / originalSize) * 100)));
  }

  createWorkerPool(size = this.activeWorkerCount) {
    return new WorkerPool(
      this.workerFactory,
      () => this.app,
      () => this.processTimeoutMs,
      () => this.initTimeoutMs,
      workerSource,
      this.wasmBytes,
      size
    );
  }

  async ensureWasmReady() {
    await this.workerPool.ensureAnyReady();
  }

  getWasmInitError() {
    return this.workerPool.getInitError();
  }

  checkBinaries() {
    return this.workerPool.getReadyState();
  }

  destroy() {
    this.workerPool.destroy(new Error("Compressor worker stopped because the plugin was unloaded"));
  }

  resize(newSize: number) {
    const numeric = typeof newSize === "number" ? newSize : Number(newSize);
    const integer = Number.isFinite(numeric)
      ? Math.trunc(numeric)
      : getInternalWorkerPoolSize(getActiveWindowForApp(this.app)?.navigator?.hardwareConcurrency);
    this.activeWorkerCount = Math.max(1, Math.min(INTERNAL_MAX_WORKER_POOL_SIZE, integer));
    this.workerPool.resize(this.activeWorkerCount);
  }

  async compress(file: FileWithOptionalVault, settings: LocalImageCompressSettings, pathOverride: string | null = null): Promise<CompressionResult> {
    let fileExtension = "";
    try {
      const vault = file?.vault || this.app?.vault;
      if (!vault || typeof vault.readBinary !== "function") {
        return {
          success: false,
          error: this.text("compress.error.fileAccess", "Unable to access file")
        };
      }
      const filePath = pathOverride || file?.path;
      if (!filePath) {
        return {
          success: false,
          error: this.text("compress.error.fileAccess", "Unable to access file")
        };
      }
      fileExtension = this.getExtension(filePath);
      if (!this.isSupportedExtension(fileExtension)) {
        throw new Error(this.text("compress.error.unsupportedFormat", "Unsupported file format"));
      }
      if (this.isTooLargeInput(file?.stat?.size)) {
        return this.getTooLargeResult(file?.stat?.size || 0, "file-size");
      }

      try {
        await this.ensureWasmReady();
      } catch (error) {
        return {
          success: false,
          error: `${this.text("warning.wasmInitFailed", "WebAssembly modules failed to initialize. Please reload the plugin or report a bug.")}: ${this.formatErrorForUser(error)}`,
          skipReason: "wasm_init_failed"
        };
      }
      const input = await this.readBinaryWithTimeout(vault, file);
      const originalBuffer = this.toArrayBuffer(input);
      const originalSize = originalBuffer.byteLength;
      if (this.isTooLargeInput(originalSize)) {
        return this.getTooLargeResult(originalSize, "file-size");
      }
      const dimensions = this.readImageDimensions(originalBuffer, fileExtension);
      if (dimensions && this.hasInvalidDimensions(dimensions)) {
        return {
          success: false,
          error: "Invalid image dimensions",
          skipReason: "invalid_image_dimensions"
        };
      }
      if (dimensions && this.isTooManyPixels(dimensions)) {
        return this.getTooLargeResult(dimensions.width * dimensions.height, "pixel-count");
      }
      const encoded = await this.compressBuffer(originalBuffer, fileExtension, settings);
      const encodedBytes = this.toUint8Array(encoded);
      this.validateEncodedOutput(fileExtension, encodedBytes);

      if (encodedBytes.byteLength >= originalSize) {
        return this.getNotSmallerResult(originalSize, encodedBytes.byteLength);
      }

      const finalOutputPath = this.getOutputPath(filePath, settings.outputFolder);
      await this.writeStagedOutput(vault.adapter, finalOutputPath, encodedBytes);
      return {
        success: true,
        savings: this.getSavingsPercentage(originalSize, encodedBytes.byteLength)
      };
    } catch (error) {
      if (this.isPngQualityFailure(error)) {
        return {
          success: false,
          error: `${this.text("compress.error.pngQuality", "PNG encoder could not meet the configured quality range")}: ${this.formatErrorForUser(error)}`,
          skipReason: "pngquant_quality_failed"
        };
      }
      if (this.isJpegEncodingFailure(error, fileExtension)) {
        return {
          success: false,
          error: this.formatErrorForUser(error),
          skipReason: "mozjpeg_failed"
        };
      }
      if (this.isCorruptEncoderOutput(error)) {
        return {
          success: false,
          error: this.formatErrorForUser(error),
          skipReason: "corrupt_encoder_output"
        };
      }
      return {
        success: false,
        error: this.formatErrorForUser(error)
      };
    }
  }

  async readBinaryWithTimeout(vault: BinaryVault, file: TFile): Promise<BinaryInput> {
    return await new Promise<BinaryInput>((resolve, reject) => {
      let settled = false;
      const windowRef = getActiveWindowForApp(this.app) || window;
      const timeout = windowRef.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`File read timed out after ${this.processTimeoutMs}ms`));
      }, this.processTimeoutMs);
      Promise.resolve()
        .then(() => vault.readBinary(file))
        .then((input) => {
          if (settled) {
            return;
          }
          settled = true;
          windowRef.clearTimeout(timeout);
          resolve(input);
        }, (error) => {
          if (settled) {
            return;
          }
          settled = true;
          windowRef.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(this.formatError(error)));
        });
    });
  }

  async compressBuffer(buffer: ArrayBuffer, fileExtension: string, settings: LocalImageCompressSettings): Promise<ArrayBuffer> {
    if (fileExtension === ".png") {
      return await this.runWorkerCompression("png", buffer, settings);
    }
    if (fileExtension === ".jpg" || fileExtension === ".jpeg") {
      return await this.runWorkerCompression("jpeg", buffer, settings);
    }
    throw new Error(this.text("compress.error.unsupportedFormat", "Unsupported file format"));
  }

  isSupportedExtension(fileExtension: string) {
    return fileExtension === ".png" || fileExtension === ".jpg" || fileExtension === ".jpeg";
  }

  validateEncodedOutput(fileExtension: string, bytes: Uint8Array) {
    if (fileExtension === ".png") {
      validateEncodedOutputFormat("png", bytes);
      return;
    }
    if (fileExtension === ".jpg" || fileExtension === ".jpeg") {
      validateEncodedOutputFormat("jpeg", bytes);
    }
  }

  async runWorkerCompression(format: WorkerFormat, buffer: ArrayBuffer, settings: LocalImageCompressSettings) {
    return await this.workerPool.runJob(format, buffer, settings);
  }

  getNotSmallerResult(originalSize: number, compressedSize: number): CompressionResult {
    void originalSize;
    void compressedSize;
    return {
      success: false,
      error: this.text("compress.error.notSmaller", "Compressed file is not smaller than original"),
      skipReason: "compressed_not_smaller"
    };
  }

  getTooLargeResult(size: number, reason: "file-size" | "pixel-count"): CompressionResult {
    const limit = reason === "file-size" ? this.maxInputBytes : this.maxImagePixels;
    return {
      success: false,
      error: `${this.text("compress.error.tooLarge", "Image is too large to compress safely")} (${size} > ${limit})`,
      skipReason: "too_large"
    };
  }

  getOutputPath(relativePath: string, outputFolder: string) {
    return `${normalizeOutputFolder(outputFolder)}/${normalizeVaultPathRoot(relativePath)}`;
  }

  async ensureAdapterDirectory(adapter: WritableBinaryAdapter | null | undefined, outputPath: string) {
    if (!adapter || typeof adapter.mkdir !== "function") {
      throw new Error(this.text("compress.error.fileAccess", "Unable to access file"));
    }
    const directoryPath = normalizeVaultPathRoot(outputPath).split("/").slice(0, -1).join("/");
    if (!directoryPath) {
      return;
    }
    const parts = directoryPath.split("/");
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (typeof adapter.exists !== "function" || !await adapter.exists(currentPath)) {
        try {
          await adapter.mkdir(currentPath);
        } catch (error) {
          if (typeof adapter.exists !== "function" || !await adapter.exists(currentPath)) {
            throw error;
          }
        }
      }
    }
  }

  async writeStagedOutput(adapter: WritableBinaryAdapter | null | undefined, finalOutputPath: string, bytes: Uint8Array) {
    await this.ensureAdapterDirectory(adapter, finalOutputPath);
    const randomSuffix = await randomHexSuffix();
    const tempOutputPath = `${finalOutputPath}.tinylocal-${Date.now()}-${randomSuffix}.tmp`;
    try {
      if (!adapter || typeof adapter.writeBinary !== "function" || typeof adapter.rename !== "function") {
        throw new Error(this.text("compress.error.fileAccess", "Unable to access file"));
      }
      await adapter.writeBinary(tempOutputPath, this.toArrayBuffer(bytes));
      await adapter.rename(tempOutputPath, finalOutputPath);
    } catch (error) {
      try {
        if (typeof adapter?.exists === "function" && typeof adapter.remove === "function" && await adapter.exists(tempOutputPath)) {
          await adapter.remove(tempOutputPath);
        }
      } catch (cleanupError) {
        console.warn(getLogTag(this), "Temporary compressed output cleanup failed:", cleanupError);
      }
      throw new Error(`${this.text("compress.error.copyCompressed", "Could not copy compressed file")}: ${this.formatErrorForUser(error)}`);
    }
  }

  toArrayBuffer(input: BinaryInput): ArrayBuffer {
    if (input instanceof ArrayBuffer) {
      return input;
    }
    const view = input instanceof Uint8Array ? input : new Uint8Array(input as Buffer);
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
      return view.buffer as ArrayBuffer;
    }
    const output = new ArrayBuffer(view.byteLength);
    new Uint8Array(output).set(view);
    return output;
  }

  toUint8Array(input: ArrayBuffer | Uint8Array | Uint8ClampedArray): Uint8Array {
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

  isPngQualityFailure(error: unknown) {
    if (error instanceof WorkerCompressionError) {
      return error.kind === "quality_failed" || error.skipReason === "pngquant_quality_failed";
    }
    return false;
  }

  isJpegEncodingFailure(error: unknown, fileExtension: string) {
    if (fileExtension !== ".jpg" && fileExtension !== ".jpeg") {
      return false;
    }
    if (error instanceof WorkerCompressionError) {
      return error.kind === "jpeg_encode_failed" || error.skipReason === "mozjpeg_failed";
    }
    const message = this.formatError(error).toLowerCase();
    return message.includes("mozjpeg") || message.includes("jpeg encode");
  }

  isCorruptEncoderOutput(error: unknown) {
    if (error instanceof WorkerCompressionError) {
      return error.kind === "corrupt_encoder_output" || error.skipReason === "corrupt_encoder_output";
    }
    return this.formatError(error).startsWith("Invalid compressed output:");
  }

  isTooLargeInput(size: unknown) {
    return typeof size === "number" && Number.isFinite(size) && size > this.maxInputBytes;
  }

  isTooManyPixels(dimensions: ImageDimensions) {
    return dimensions.width > 0 && dimensions.height > 0 && dimensions.width * dimensions.height > this.maxImagePixels;
  }

  hasInvalidDimensions(dimensions: ImageDimensions) {
    return dimensions.width <= 0 || dimensions.height <= 0;
  }

  getExtension(filePath: string) {
    const match = String(filePath || "").toLowerCase().match(/\.[^./\\]+$/);
    return match ? match[0] : "";
  }

  readImageDimensions(buffer: ArrayBuffer, fileExtension: string): ImageDimensions | null {
    const bytes = new Uint8Array(buffer);
    if (fileExtension === ".png") {
      return this.readPngDimensions(bytes);
    }
    if (fileExtension === ".jpg" || fileExtension === ".jpeg") {
      return this.readJpegDimensions(bytes);
    }
    return null;
  }

  readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
    if (bytes.byteLength < 24) {
      return null;
    }
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => bytes[index] === value)) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      width: view.getUint32(16, false),
      height: view.getUint32(20, false)
    };
  }

  readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
    if (bytes.byteLength < 4 || bytes[0] !== 255 || bytes[1] !== 216) {
      return null;
    }
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      while (offset < bytes.byteLength && bytes[offset] === 255) {
        offset++;
      }
      if (offset >= bytes.byteLength) {
        return null;
      }
      const marker = bytes[offset++] ?? 0;
      if (marker === 217 || marker === 218) {
        return null;
      }
      if (offset + 1 >= bytes.byteLength) {
        return null;
      }
      const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
      if (length < 2 || offset + length > bytes.byteLength) {
        return null;
      }
      if (this.isJpegStartOfFrame(marker) && length >= 7) {
        return {
          height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
          width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)
        };
      }
      offset += length;
    }
    return null;
  }

  isJpegStartOfFrame(marker: number) {
    return marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker);
  }

  formatError(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" && error
      ? error
      : this.text("compress.error.unknown", "unknown error");
  }

  formatErrorForUser(error: unknown) {
    return sanitizeErrorForUser(this.formatError(error));
  }
}
