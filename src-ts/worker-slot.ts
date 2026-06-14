import type { LocalImageCompressSettings } from "./settings";
import type { TimerHandle } from "./types";
import { clearTimeout as fallbackClearTimeout, setTimeout as fallbackSetTimeout } from "timers";
import { getActiveWindowForApp } from "./utils";

export type WorkerFormat = "png" | "jpeg";
export type WorkerFactory = (source: string) => Worker;
export type WorkerInputBuffer = ArrayBuffer | ArrayBufferView;

export type WasmBytes = {
  jpegDecode: Uint8Array;
  jpegEncode: Uint8Array;
  png: Uint8Array;
  imagequant: Uint8Array;
};

type WorkerErrorPayload = {
  kind?: string;
  message?: string;
  skipReason?: string;
};

export type WorkerHostApp = unknown;

type WorkerMessageEnvelope = {
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  output?: unknown;
  error?: WorkerErrorPayload;
};

type ActiveWorkerJob = {
  id: number;
  timeoutHandle: TimerHandle;
  resolve: (value: ArrayBuffer) => void;
  reject: (reason?: unknown) => void;
};

type ActiveWorkerInit = {
  id: number;
  timeoutHandle: TimerHandle;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

export class WasmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmTimeoutError";
  }
}

export class WorkerCompressionError extends Error {
  kind: string;
  skipReason?: string;

  constructor(payload: WorkerErrorPayload) {
    super(payload.message || "Worker compression failed");
    this.name = "WorkerCompressionError";
    this.kind = payload.kind || "unknown";
    if (payload.skipReason !== undefined) {
      this.skipReason = payload.skipReason;
    }
  }
}

export class WorkerSlot {
  worker: Worker | null;
  objectUrl: string | null;
  workerInit: ActiveWorkerInit | null;
  activeJob: ActiveWorkerJob | null;
  wasmReady: boolean;
  wasmInitError: Error | null;
  needsRecreate: boolean;
  destroyed: boolean;
  nextMessageId: number;
  private initPromise: Promise<void> | null;
  private reserved: boolean;

  constructor(
    private readonly workerFactory: WorkerFactory | null,
    private readonly getApp: () => WorkerHostApp,
    private readonly getTimeoutMs: () => number,
    private readonly getInitTimeoutMs: () => number,
    private readonly workerSource: string,
    private readonly wasmBytes: WasmBytes
  ) {
    this.worker = null;
    this.objectUrl = null;
    this.workerInit = null;
    this.activeJob = null;
    this.wasmReady = false;
    this.wasmInitError = null;
    this.needsRecreate = false;
    this.destroyed = false;
    this.nextMessageId = 1;
    this.initPromise = null;
    this.reserved = false;
  }

  init(): Promise<void> {
    if (this.destroyed) {
      const error = this.wasmInitError || new Error("Compressor has been destroyed");
      this.wasmInitError = error;
      return Promise.reject(error);
    }
    if (this.wasmReady) {
      return Promise.resolve();
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    if (this.wasmInitError && !this.needsRecreate) {
      return Promise.reject(this.wasmInitError);
    }

    this.needsRecreate = false;
    this.wasmReady = false;
    this.wasmInitError = null;
    const id = this.nextMessageId++;
    this.initPromise = new Promise<void>((resolve, reject) => {
      const initTimeoutMs = this.getInitTimeoutMs();
      const timeoutHandle = this.setWorkerTimeout(() => {
        if (this.destroyed) {
          return;
        }
        if (this.workerInit?.id !== id) {
          return;
        }
        const error = new WasmTimeoutError(`WASM worker init timed out after ${initTimeoutMs}ms`);
        this.failActiveWorkerState(error, true);
      }, initTimeoutMs);
      this.workerInit = { id, timeoutHandle, resolve, reject };
      try {
        const worker = this.createWorker();
        // KKK2-A-5: attach error/message handlers BEFORE storing the reference so a
        // worker that surfaces a creation error has a handler in place (Lesson #211).
        worker.onmessage = (event) => this.handleWorkerMessage(event.data);
        worker.onerror = (event) => this.handleWorkerError(event);
        this.worker = worker;
        const wasm = {
          jpegDecode: this.cloneAsArrayBuffer(this.wasmBytes.jpegDecode),
          jpegEncode: this.cloneAsArrayBuffer(this.wasmBytes.jpegEncode),
          png: this.cloneAsArrayBuffer(this.wasmBytes.png),
          imagequant: this.cloneAsArrayBuffer(this.wasmBytes.imagequant)
        };
        worker.postMessage({ id, type: "init", wasm }, [
          wasm.jpegDecode,
          wasm.jpegEncode,
          wasm.png,
          wasm.imagequant
        ]);
      } catch (error) {
        this.clearWorkerTimeout(timeoutHandle);
        this.workerInit = null;
        this.wasmReady = false;
        this.wasmInitError = error instanceof Error ? error : new Error(String(error));
        this.terminateWorker();
        reject(this.wasmInitError);
      }
    }).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  isReady() {
    return this.wasmReady && !!this.worker && !this.destroyed;
  }

  isBusy() {
    return this.reserved || !!this.workerInit || !!this.activeJob;
  }

  isInitializing() {
    return !!this.workerInit;
  }

  getInitError() {
    return this.wasmInitError;
  }

  canAcceptJob() {
    return !this.destroyed && !this.isBusy() && (!this.wasmInitError || this.needsRecreate);
  }

  shouldRecreateOnDemand() {
    return this.needsRecreate && this.canAcceptJob();
  }

  allowInitRetry() {
    if (this.wasmInitError && !this.destroyed) {
      this.needsRecreate = true;
    }
  }

  tryReserve() {
    if (!this.canAcceptJob()) {
      return false;
    }
    this.reserved = true;
    return true;
  }

  async runCompression(format: WorkerFormat, buffer: WorkerInputBuffer, settings: LocalImageCompressSettings): Promise<ArrayBuffer> {
    if (!this.reserved && !this.tryReserve()) {
      throw new Error("Compression worker is already busy");
    }
    try {
      const transferableBuffer = this.normalizeCompressionBuffer(buffer);
      await this.init();
      const worker = this.worker;
      if (!worker) {
        throw new Error("Compression worker is not available");
      }
      if (this.activeJob) {
        throw new Error("Compression worker is already busy");
      }
      const id = this.nextMessageId++;
      const timeoutMs = this.getTimeoutMs();
      return await new Promise<ArrayBuffer>((resolve, reject) => {
        const timeoutHandle = this.setWorkerTimeout(() => {
          if (this.destroyed) {
            return;
          }
          if (!this.activeJob || this.activeJob.id !== id) {
            return;
          }
          const error = new WasmTimeoutError(`WASM worker timed out after ${timeoutMs}ms`);
          this.failActiveWorkerState(error, true);
        }, timeoutMs);

        this.activeJob = { id, timeoutHandle, resolve, reject };
        try {
          if (this.destroyed || this.worker !== worker) {
            throw new Error("Compression worker is not available");
          }
          worker.postMessage({
            id,
            type: "compress",
            format,
            buffer: transferableBuffer,
            settings: {
              pngQuality: {
                min: settings.pngQuality.min,
                max: settings.pngQuality.max
              },
              jpegQuality: settings.jpegQuality
            },
          }, [transferableBuffer]);
        } catch (error) {
          if (this.activeJob?.id === id) {
            this.clearWorkerTimeout(timeoutHandle);
            this.activeJob = null;
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      this.reserved = false;
    }
  }

  terminate(error = new Error("Compression worker stopped")) {
    if (this.workerInit) {
      const init = this.workerInit;
      this.workerInit = null;
      this.clearWorkerTimeout(init.timeoutHandle);
      init.reject(error);
    }
    if (this.activeJob) {
      const job = this.activeJob;
      this.activeJob = null;
      this.clearWorkerTimeout(job.timeoutHandle);
      job.reject(error);
    }
    this.wasmReady = false;
    this.terminateWorker();
  }

  destroy(error: Error) {
    this.destroyed = true;
    this.needsRecreate = false;
    this.wasmInitError = error;
    this.terminate(error);
  }

  private createWorker() {
    if (this.workerFactory) {
      return this.workerFactory(this.workerSource);
    }
    const blob = new Blob([this.workerSource], { type: "text/javascript" });
    this.objectUrl = URL.createObjectURL(blob);
    return new Worker(this.objectUrl);
  }

  private handleWorkerMessage(message: unknown) {
    if (!message || typeof message !== "object") {
      this.logUnhandledWorkerMessage(message);
      return;
    }
    const workerMessage = message as WorkerMessageEnvelope;
    if ((workerMessage.type === "ready" || workerMessage.type === "init-failed") && this.workerInit?.id === workerMessage.id) {
      const init = this.workerInit!;
      this.workerInit = null;
      this.clearWorkerTimeout(init.timeoutHandle);
      if (workerMessage.type === "ready") {
        this.revokeObjectUrl();
        this.wasmReady = true;
        this.wasmInitError = null;
        init.resolve();
      } else {
        this.wasmReady = false;
        this.wasmInitError = new Error(workerMessage.error?.message || "Worker WASM initialization failed");
        this.terminateWorker();
        init.reject(this.wasmInitError);
      }
      return;
    }
    if (workerMessage.type === "result" && this.activeJob?.id === workerMessage.id) {
      const job = this.activeJob!;
      this.activeJob = null;
      this.clearWorkerTimeout(job.timeoutHandle);
      if (workerMessage.ok) {
        job.resolve(this.toArrayBuffer(workerMessage.output as ArrayBuffer | Uint8Array));
      } else {
        job.reject(new WorkerCompressionError(workerMessage.error || {}));
      }
      return;
    }
    this.logUnhandledWorkerMessage(message);
  }

  private logUnhandledWorkerMessage(message: unknown) {
    const envelope = message && typeof message === "object" ? message as WorkerMessageEnvelope : null;
    console.debug("[Local Image Compress]", "Unhandled worker message:", {
      type: envelope ? envelope.type : typeof message,
      id: envelope ? envelope.id : undefined,
      expecting: {
        init: this.workerInit?.id ?? null,
        job: this.activeJob?.id ?? null
      },
      wasmReady: this.wasmReady,
      needsRecreate: this.needsRecreate,
      destroyed: this.destroyed
    });
  }

  private handleWorkerError(event: ErrorEvent | Event | { message?: unknown }) {
    const message = "message" in event && typeof event.message === "string" ? event.message : "unknown error";
    const error = new Error(`Worker crashed: ${message}`);
    this.failActiveWorkerState(error, true);
  }

  private failActiveWorkerState(error: Error, recreate: boolean) {
    this.wasmReady = false;
    this.wasmInitError = error;
    if (this.workerInit) {
      const init = this.workerInit;
      this.workerInit = null;
      this.clearWorkerTimeout(init.timeoutHandle);
      init.reject(error);
    }
    if (this.activeJob) {
      const job = this.activeJob;
      this.activeJob = null;
      this.clearWorkerTimeout(job.timeoutHandle);
      job.reject(error);
    }
    this.terminateWorker();
    if (recreate && !this.destroyed) {
      this.needsRecreate = true;
      this.wasmInitError = null;
      this.workerInit = null;
    } else {
      this.needsRecreate = false;
    }
  }

  private terminateWorker() {
    try {
      this.worker?.terminate();
    } catch (error) {
      void error;
    }
    this.worker = null;
    this.revokeObjectUrl();
  }

  private revokeObjectUrl() {
    if (!this.objectUrl) {
      return;
    }
    try {
      URL.revokeObjectURL(this.objectUrl);
    } catch (error) {
      void error;
    }
    this.objectUrl = null;
  }

  private setWorkerTimeout(callback: () => void, delay: number) {
    const windowRef = getActiveWindowForApp(this.getApp());
    if (windowRef) {
      return windowRef.setTimeout(callback, delay);
    }
    if (typeof window !== "undefined") {
      return window.setTimeout(callback, delay);
    }
    return fallbackSetTimeout(callback, delay);
  }

  private clearWorkerTimeout(timeoutHandle: TimerHandle | null | undefined) {
    if (timeoutHandle === null || timeoutHandle === undefined) {
      return;
    }
    const windowRef = getActiveWindowForApp(this.getApp());
    if (windowRef) {
      windowRef.clearTimeout(timeoutHandle as number);
      return;
    }
    if (typeof window !== "undefined") {
      window.clearTimeout(timeoutHandle as number);
      return;
    }
    fallbackClearTimeout(timeoutHandle);
  }

  private cloneAsArrayBuffer(input: Uint8Array) {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    return copy.buffer;
  }

  private normalizeCompressionBuffer(input: unknown): ArrayBuffer {
    if (input instanceof ArrayBuffer) {
      if (input.byteLength === 0) {
        throw new TypeError("Expected a non-empty ArrayBuffer; received an empty or detached buffer");
      }
      return input;
    }
    if (ArrayBuffer.isView(input)) {
      if (input.byteLength === 0) {
        throw new TypeError("Expected a non-empty ArrayBuffer view; received an empty view");
      }
      const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    }
    const received = input === null ? "null" : typeof input;
    throw new TypeError(`Expected ArrayBuffer or ArrayBuffer view, got ${received}`);
  }

  private toArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
    if (input instanceof ArrayBuffer) {
      return input;
    }
    if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) {
      return input.buffer as ArrayBuffer;
    }
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  }
}
