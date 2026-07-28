import workerSource from "virtual:compression-worker";
import jpegDecodeWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import jpegEncodeWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";
import * as pngWasmModule from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import imagequantWasm from "imagequant/imagequant_bg.wasm";
import jpegPackage from "@jsquash/jpeg/package.json";
import pngPackage from "@jsquash/png/package.json";
import imagequantPackage from "imagequant/package.json";
import type { CompressionOperationInput, CompressionResult } from "./types";
import {
  getMaxImagePixelsMillions,
  getMaxInputSizeMb,
  getCompressionMemoryBudgetBytes,
  getCompressionSettingsKeyForSnapshot,
  getPlatformWorkerPoolSize,
  INTERNAL_COMPRESSION_TIMEOUT_SECONDS,
  INTERNAL_MAX_WORKER_POOL_SIZE,
  INTERNAL_WASM_INIT_TIMEOUT_SECONDS,
  type LocalImageCompressSettings
} from "./settings";
import { t } from "./i18n";
import { validateEncodedOutputFormat } from "./encoded-output-validator";
import { getActiveWindowForApp, getLogTag, normalizeOutputFolder, normalizeVaultPathRoot, randomHexSuffix, sanitizeErrorForUser } from "./utils";
import { WorkerPool } from "./worker-pool";
import { MemoryBudgetLimiter, type MemoryBudgetReservation } from "./memory-budget-limiter";
import { WorkerCompressionError, type WasmBytes, type WorkerFactory, type WorkerFormat } from "./worker-slot";
import { Platform, type App, type TFile } from "obsidian";
import type { BufferedOperationToken, FsPort, HashPort } from "./platform/ports";

function isMobilePlatform(): boolean {
  return typeof Platform === "object" && Platform !== null && Platform.isMobile === true;
}

// The package ships a wasm-bindgen declaration, while esbuild's binary loader exposes default bytes.
const pngWasm = (pngWasmModule as unknown as { default: Uint8Array }).default;

export const PACKAGE_VERSIONS = {
  jpeg: jpegPackage.version,
  png: pngPackage.version,
  imagequant: imagequantPackage.version
};

type BinaryInput = ArrayBuffer | Uint8Array;
type BinaryVault = {
  readBinary(file: TFile): Promise<BinaryInput>;
};
type FileWithOptionalVault = TFile & {
  vault?: BinaryVault;
};
type ImageDimensions = {
  width: number;
  height: number;
};
type OutputRevision =
  | { expectedTargetSha256: string; expectedTargetMissing?: never }
  | { expectedTargetMissing: true; expectedTargetSha256?: never };
type ReadOutcome =
  | { kind: "input"; input: BinaryInput }
  | { kind: "error"; error: unknown }
  | { kind: "timeout"; error: Error };

export class Compressor {
  processTimeoutMs: number;
  initTimeoutMs: number;
  maxInputBytes: number;
  maxImagePixels: number;
  memoryBudgetBytes: number;
  app: App | null;
  workerFactory: WorkerFactory | null;
  workerPool: WorkerPool;
  activeWorkerCount: number;
  wasmBytes: WasmBytes;
  fsPort: FsPort;
  hashPort: HashPort;
  memoryLimiter: MemoryBudgetLimiter;
  readAdmissionLimiter: MemoryBudgetLimiter;
  private lifecycleGeneration = 0;
  private readonly lateOperations = new Set<Promise<void>>();

  constructor(settings: LocalImageCompressSettings, app: App | null, workerFactory: WorkerFactory | null, fsPort: FsPort, hashPort: HashPort) {
    this.processTimeoutMs = INTERNAL_COMPRESSION_TIMEOUT_SECONDS * 1000;
    this.initTimeoutMs = INTERNAL_WASM_INIT_TIMEOUT_SECONDS * 1000;
    this.maxInputBytes = getMaxInputSizeMb(isMobilePlatform()) * 1024 * 1024;
    this.maxImagePixels = getMaxImagePixelsMillions(isMobilePlatform()) * 1_000_000;
    this.memoryBudgetBytes = getCompressionMemoryBudgetBytes(isMobilePlatform());
    this.app = app;
    this.workerFactory = workerFactory;
    this.fsPort = fsPort;
    this.hashPort = hashPort;
    this.activeWorkerCount = getPlatformWorkerPoolSize(isMobilePlatform(), getActiveWindowForApp(this.app)?.navigator?.hardwareConcurrency);
    this.applySettings(settings);
    this.wasmBytes = {
      jpegDecode: jpegDecodeWasm,
      jpegEncode: jpegEncodeWasm,
      png: pngWasm,
      imagequant: imagequantWasm
    };
    this.workerPool = this.createWorkerPool(this.activeWorkerCount);
    this.memoryLimiter = new MemoryBudgetLimiter(this.memoryBudgetBytes);
    this.readAdmissionLimiter = new MemoryBudgetLimiter(this.maxInputBytes);
  }

  applySettings(settings: LocalImageCompressSettings) {
    void settings;
    this.processTimeoutMs = INTERNAL_COMPRESSION_TIMEOUT_SECONDS * 1000;
    this.initTimeoutMs = INTERNAL_WASM_INIT_TIMEOUT_SECONDS * 1000;
    this.maxInputBytes = getMaxInputSizeMb(isMobilePlatform()) * 1024 * 1024;
    this.maxImagePixels = getMaxImagePixelsMillions(isMobilePlatform()) * 1_000_000;
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
    const error = new Error("Compressor worker stopped because the plugin was unloaded");
    this.lifecycleGeneration++;
    this.readAdmissionLimiter.destroy(error);
    this.memoryLimiter.destroy(error);
    this.workerPool.destroy(error);
  }

  resize(newSize: number) {
    const numeric = typeof newSize === "number" ? newSize : Number(newSize);
    const integer = Number.isFinite(numeric)
      ? Math.trunc(numeric)
      : getPlatformWorkerPoolSize(isMobilePlatform(), getActiveWindowForApp(this.app)?.navigator?.hardwareConcurrency);
    this.activeWorkerCount = Math.max(1, Math.min(isMobilePlatform() ? 1 : INTERNAL_MAX_WORKER_POOL_SIZE, integer));
    this.workerPool.resize(this.activeWorkerCount);
  }

  async compress(file: FileWithOptionalVault, settings: LocalImageCompressSettings, operation: CompressionOperationInput): Promise<CompressionResult> {
    const lifecycleGeneration = this.lifecycleGeneration;
    let notifyReadTimeout!: (error: Error) => void;
    const readTimeoutResult = new Promise<CompressionResult>((resolve) => {
      notifyReadTimeout = (error) => resolve({ success: false, error: this.formatErrorForUser(error) });
    });
    const operationPromise = this.fsPort.runBufferedOperation(async (bufferedOperationToken) =>
      await this.compressWithBufferedPermit(file, settings, operation, bufferedOperationToken, lifecycleGeneration, notifyReadTimeout)
    );
    const completedOperation = operationPromise.then(
      (result) => ({ kind: "completed" as const, result }),
      (error: unknown) => ({
        kind: "completed" as const,
        result: { success: false, error: this.formatErrorForUser(error) } as CompressionResult
      })
    );
    const winner = await Promise.race([
      completedOperation,
      readTimeoutResult.then((result) => ({ kind: "timeout" as const, result }))
    ]);
    if (winner.kind === "timeout") {
      this.trackLateOperation(operationPromise);
    }
    return winner.result;
  }

  private async compressWithBufferedPermit(
    file: FileWithOptionalVault,
    settings: LocalImageCompressSettings,
    operation: CompressionOperationInput,
    bufferedOperationToken: BufferedOperationToken,
    lifecycleGeneration: number,
    notifyReadTimeout: (error: Error) => void
  ): Promise<CompressionResult> {
    let fileExtension = "";
    const memoryReservation: { current: MemoryBudgetReservation | null } = { current: null };
    try {
      this.assertLifecycle(lifecycleGeneration);
      const vault = file?.vault || this.app?.vault;
      if (!vault || typeof vault.readBinary !== "function") {
        return {
          success: false,
          error: this.text("compress.error.fileAccess", "Unable to access file")
        };
      }
      const filePath = operation?.sourcePath || file?.path;
      if (!filePath) {
        return {
          success: false,
          error: this.text("compress.error.fileAccess", "Unable to access file")
        };
      }
      if (operation && (file.path !== operation.sourcePath || file.stat?.mtime !== operation.sourceMtime)) {
        throw new Error(`Compression source changed before read: ${operation.sourcePath}`);
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
        this.assertLifecycle(lifecycleGeneration);
      } catch (error) {
        return {
          success: false,
          error: `${this.text("warning.wasmInitFailed", "WebAssembly modules failed to initialize. Please reload the plugin or report a bug.")}: ${this.formatErrorForUser(error)}`,
          skipReason: "wasm_init_failed"
        };
      }
      const finalOutputPath = this.getOutputPath(filePath, settings.outputFolder);
      const prepared = await this.readAdmissionLimiter.run(this.maxInputBytes, async () => {
        memoryReservation.current = await this.memoryLimiter.reserve(this.maxInputBytes);
        this.assertLifecycle(lifecycleGeneration);
        const input = await this.readBinaryWithTimeout(vault, file, notifyReadTimeout);
        this.assertLifecycle(lifecycleGeneration);
        if (operation && (file.path !== operation.sourcePath || file.stat?.mtime !== operation.sourceMtime)) {
          throw new Error(`Compression source changed during read: ${operation.sourcePath}`);
        }
        const retainedInputBytes = input instanceof ArrayBuffer
          ? input.byteLength
          : input.buffer.byteLength;
        const actualInputBytes = Math.max(input.byteLength, retainedInputBytes);
        if (this.isTooLargeInput(actualInputBytes)) {
          return { kind: "too-large" as const, actualInputBytes };
        }
        const requiresOwnedArrayBufferCopy = !(input instanceof ArrayBuffer)
          && (input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength);
        const copyAdmissionWeight = requiresOwnedArrayBufferCopy
          ? Math.max(this.maxInputBytes, retainedInputBytes) + input.byteLength
          : this.maxInputBytes;
        if (requiresOwnedArrayBufferCopy) {
          await memoryReservation.current.resize(copyAdmissionWeight);
        }
        const originalBuffer = this.toArrayBuffer(input);
        const originalSize = originalBuffer.byteLength;
        const sourceBytes = new Uint8Array(originalBuffer);
        const sourceMd5 = this.hashPort.md5Hex(sourceBytes);
        const sourceSha256 = this.hashPort.sha256Hex(sourceBytes);
        const dimensions = this.readImageDimensions(originalBuffer, fileExtension);
        await memoryReservation.current.resize(Math.max(
          copyAdmissionWeight,
          this.estimateCompressionMemoryBytes(dimensions, originalSize)
        ));
        this.assertLifecycle(lifecycleGeneration);
        const outputRevision = await this.captureOutputRevision(finalOutputPath, bufferedOperationToken);
        this.assertLifecycle(lifecycleGeneration);
        return { kind: "ready" as const, originalBuffer, originalSize, sourceMd5, sourceSha256, dimensions, outputRevision };
      });
      if (prepared.kind === "too-large") {
        return this.getTooLargeResult(prepared.actualInputBytes, "file-size");
      }
      const { originalBuffer, originalSize, sourceMd5, sourceSha256, dimensions, outputRevision } = prepared;
      if (this.isTooLargeInput(originalSize)) {
        return this.getTooLargeResult(originalSize, "file-size");
      }
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
      this.assertLifecycle(lifecycleGeneration);
      const encodedBytes = this.toUint8Array(encoded);
      this.validateEncodedOutput(fileExtension, encodedBytes);

      if (encodedBytes.byteLength >= originalSize) {
        return this.getNotSmallerResult(originalSize, encodedBytes.byteLength);
      }

      const outputSha256 = this.hashPort.sha256Hex(encodedBytes);
      if (operation && (file.path !== operation.sourcePath || file.stat?.mtime !== operation.sourceMtime)) {
        throw new Error(`Compression source changed during encode: ${operation.sourcePath}`);
      }
      if (await this.hashPort.fileSha256Hex(filePath, bufferedOperationToken) !== sourceSha256) {
        throw new Error(`Compression source content changed during encode: ${filePath}`);
      }
      this.assertLifecycle(lifecycleGeneration);
      await this.writeStagedOutput(
        finalOutputPath,
        encodedBytes,
        outputSha256,
        outputRevision,
        lifecycleGeneration,
        async () => {
          if (await this.hashPort.fileSha256Hex(filePath, bufferedOperationToken) !== sourceSha256) {
            throw new Error(`Compression source content changed before publication: ${filePath}`);
          }
        },
        bufferedOperationToken
      );
      const sourceMtime = Number.isFinite(operation?.sourceMtime)
        ? operation.sourceMtime
        : file?.stat?.mtime;
      if (!Number.isFinite(sourceMtime)) {
        throw new Error(`Compression source mtime is unavailable: ${filePath}`);
      }
      const compressionSettingsKey = getCompressionSettingsKeyForSnapshot(fileExtension, settings);
      if (!compressionSettingsKey) {
        throw new Error(`Compression settings identity is unavailable: ${filePath}`);
      }
      return {
        success: true,
        savings: this.getSavingsPercentage(originalSize, encodedBytes.byteLength),
        artifact: {
          sourcePath: filePath,
          sourceMtime,
          sourceSize: originalSize,
          sourceMd5,
          sourceSha256,
          outputPath: finalOutputPath,
          outputSize: encodedBytes.byteLength,
          outputSha256,
          compressionSettingsKey
        }
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
    } finally {
      memoryReservation.current?.release();
    }
  }

  async readBinaryWithTimeout(vault: BinaryVault, file: TFile, notifyTimeout: (error: Error) => void): Promise<BinaryInput> {
    const windowRef = getActiveWindowForApp(this.app) || window;
    const readOutcome = Promise.resolve()
      .then(() => vault.readBinary(file))
      .then<ReadOutcome, ReadOutcome>(
        (input) => ({ kind: "input", input }),
        (error: unknown) => ({ kind: "error", error })
      );
    let timeoutHandle: number | null = null;
    const timeoutOutcome = new Promise<ReadOutcome>((resolve) => {
      timeoutHandle = windowRef.setTimeout(() => {
        resolve({ kind: "timeout", error: new Error(`File read timed out after ${this.processTimeoutMs}ms`) });
      }, this.processTimeoutMs);
    });
    const firstOutcome = await Promise.race([readOutcome, timeoutOutcome]);
    if (firstOutcome.kind === "input") {
      if (timeoutHandle !== null) {
        windowRef.clearTimeout(timeoutHandle);
      }
      return firstOutcome.input;
    }
    if (firstOutcome.kind === "error") {
      if (timeoutHandle !== null) {
        windowRef.clearTimeout(timeoutHandle);
      }
      throw firstOutcome.error instanceof Error
        ? firstOutcome.error
        : new Error(this.formatError(firstOutcome.error));
    }
    notifyTimeout(firstOutcome.error);
    const lateOutcome = await readOutcome;
    if (lateOutcome.kind === "error") {
      console.debug(getLogTag(this), "Timed-out file read later rejected:", lateOutcome.error);
    }
    throw firstOutcome.error;
  }

  private trackLateOperation(operation: Promise<CompressionResult>) {
    let tracked!: Promise<void>;
    tracked = operation.then(
      () => {
        this.lateOperations.delete(tracked);
      },
      (error: unknown) => {
        this.lateOperations.delete(tracked);
        console.debug(getLogTag(this), "Timed-out compression lifetime later rejected:", error);
      }
    );
    this.lateOperations.add(tracked);
  }

  private assertLifecycle(expectedGeneration: number) {
    if (expectedGeneration !== this.lifecycleGeneration) {
      throw new Error("Compressor worker stopped because the plugin was unloaded");
    }
  }

  private async captureOutputRevision(finalOutputPath: string, bufferedOperationToken: BufferedOperationToken): Promise<OutputRevision> {
    const stat = await this.fsPort.stat(finalOutputPath);
    if (!stat) {
      return { expectedTargetMissing: true };
    }
    if (stat.isDirectory) {
      throw new Error(`Compression output target is a directory: ${finalOutputPath}`);
    }
    return {
      expectedTargetSha256: await this.hashPort.fileSha256Hex(finalOutputPath, bufferedOperationToken)
    };
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

  async writeStagedOutput(
    finalOutputPath: string,
    bytes: Uint8Array,
    expectedSha256: string,
    outputRevision: OutputRevision,
    lifecycleGeneration: number,
    assertSourceUnchanged: () => Promise<void>,
    bufferedOperationToken?: BufferedOperationToken
  ) {
    const randomSuffix = await randomHexSuffix();
    this.assertLifecycle(lifecycleGeneration);
    const tempOutputPath = `${finalOutputPath}.tinylocal-${Date.now()}-${randomSuffix}.tmp`;
    try {
      await this.fsPort.mkdir(this.fsPort.dirnamePath(finalOutputPath));
      this.assertLifecycle(lifecycleGeneration);
      await this.fsPort.writeBinary(tempOutputPath, this.toArrayBuffer(bytes), bufferedOperationToken);
      this.assertLifecycle(lifecycleGeneration);
      await assertSourceUnchanged();
      this.assertLifecycle(lifecycleGeneration);
      const replacement = await this.fsPort.replaceFile(tempOutputPath, finalOutputPath, {
        ...outputRevision,
        expectedStagedSha256: expectedSha256,
        canCommit: () => lifecycleGeneration === this.lifecycleGeneration,
        ...(bufferedOperationToken ? { bufferedOperationToken } : {})
      });
      if (replacement.leftoverRollbackPath) {
        console.warn(getLogTag(this), "Compressed output replacement left a recoverable rollback file:", replacement.leftoverRollbackPath);
      }
    } catch (error) {
      try {
        await this.fsPort.removeFileIfUnchanged(tempOutputPath, expectedSha256, bufferedOperationToken);
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
    const view = input;
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
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
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

  estimateCompressionMemoryBytes(dimensions: ImageDimensions | null, inputBytes: number) {
    if (!dimensions) {
      return this.memoryBudgetBytes;
    }
    // Decode + codec/WASM ownership can hold two RGBA images while the main
    // thread and transferable worker input retain roughly two encoded copies.
    return (dimensions.width * dimensions.height * 8) + (inputBytes * 2);
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
