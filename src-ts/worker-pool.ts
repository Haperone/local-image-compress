import type { LocalImageCompressSettings } from "./settings";
import { WorkerSlot, type WasmBytes, type WorkerFactory, type WorkerFormat, type WorkerHostApp } from "./worker-slot";
import type { TimerHandle } from "./types";

type SlotWaiter = {
  resolve: (slot: WorkerSlot) => void;
  reject: (reason?: unknown) => void;
};

function clampPoolSize(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : 1;
  return Math.max(1, Math.min(8, integer));
}

export class WorkerPool {
  slots: WorkerSlot[];
  waiters: SlotWaiter[];
  destroyed: boolean;
  private destroyError: Error | null;
  private staggeredInitQueue: WorkerSlot[];
  private staggeredInitActive: boolean;
  private staggeredInitTimer: TimerHandle | null;
  private readonly MAX_WAITERS = 5000;

  constructor(
    private readonly workerFactory: WorkerFactory | null,
    private readonly getApp: () => WorkerHostApp,
    private readonly getTimeoutMs: () => number,
    private readonly getInitTimeoutMs: () => number,
    private readonly workerSource: string,
    private readonly wasmBytes: WasmBytes,
    initialSize: number
  ) {
    this.slots = [];
    this.waiters = [];
    this.destroyed = false;
    this.destroyError = null;
    this.staggeredInitQueue = [];
    this.staggeredInitActive = false;
    this.staggeredInitTimer = null;
    this.resize(initialSize);
  }

  getReadyState() {
    const anyReady = this.slots.some((slot) => slot.isReady());
    return {
      pngquant: anyReady,
      mozjpeg: anyReady
    };
  }

  getInitError() {
    if (this.destroyed) {
      return this.destroyError || new Error("Compressor worker stopped because the plugin was unloaded");
    }
    if (this.slots.length === 0 || this.slots.some((slot) => slot.isReady() || !slot.getInitError())) {
      return null;
    }
    const firstError = this.slots[0]?.getInitError();
    return firstError || new Error("All compression workers failed to initialize");
  }

  async ensureAnyReady(): Promise<void> {
    if (this.destroyed) {
      throw this.getInitError() ?? new Error("Compressor worker stopped");
    }
    if (this.slots.some((slot) => slot.isReady())) {
      return;
    }
    if (this.slots.length === 0) {
      throw new Error("Compression worker pool is empty");
    }

    const errors: Error[] = [];
    while (!this.destroyed) {
      const readySlot = this.slots.find((slot) => slot.isReady());
      if (readySlot) {
        return;
      }
      const initError = this.getInitError();
      if (initError) {
        throw errors[0] || initError;
      }
      const slot = this.findReadinessSlot();
      if (!slot) {
        throw errors[0] || new Error("No compression worker is available");
      }
      try {
        await slot.init();
        this.enableInitRetryForFailedSlots();
        this.dispatchWaiters();
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        this.enableInitRetryForFailedSlots();
        this.dispatchWaiters();
      }
    }
    throw this.getInitError() ?? new Error("Compressor worker stopped");
  }

  async runJob(format: WorkerFormat, buffer: ArrayBuffer, settings: LocalImageCompressSettings): Promise<ArrayBuffer> {
    const slot = await this.acquireSlot();
    try {
      return await slot.runCompression(format, buffer, settings);
    } finally {
      this.enableInitRetryForFailedSlots();
      this.dispatchWaiters();
    }
  }

  async drainInFlight(timeoutMs = 5000) {
    const startedAt = Date.now();
    while (!this.destroyed && (this.waiters.length > 0 || this.slots.some((slot) => slot.isBusy()))) {
      this.dispatchWaiters();
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await new Promise((resolve) => this.setWindowTimeout(() => resolve(undefined), 25));
    }
    return true;
  }

  resize(newSize: number) {
    const size = clampPoolSize(newSize);
    if (size > this.slots.length) {
      while (this.slots.length < size) {
        const slot = this.createSlot();
        this.slots.push(slot);
        this.queueSlotInit(slot);
      }
      return;
    }
    if (size < this.slots.length) {
      const removed = this.slots.splice(size);
      this.staggeredInitQueue = this.staggeredInitQueue.filter((slot) => !removed.includes(slot));
      for (const slot of removed) {
        slot.destroy(new Error("Compression worker pool was resized"));
      }
    }
    this.dispatchWaiters();
  }

  destroy(error: Error) {
    this.destroyed = true;
    this.destroyError = error;
    this.staggeredInitQueue = [];
    if (this.staggeredInitTimer) {
      this.clearWindowTimeout(this.staggeredInitTimer);
      this.staggeredInitTimer = null;
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
    for (const slot of this.slots) {
      slot.destroy(error);
    }
  }

  private createSlot() {
    return new WorkerSlot(
      this.workerFactory,
      this.getApp,
      this.getTimeoutMs,
      this.getInitTimeoutMs,
      this.workerSource,
      this.wasmBytes
    );
  }

  private queueSlotInit(slot: WorkerSlot) {
    this.staggeredInitQueue.push(slot);
    this.startNextStaggeredSlotInit();
  }

  private startNextStaggeredSlotInit() {
    if (this.destroyed || this.staggeredInitActive || this.staggeredInitTimer) {
      return;
    }
    const slot = this.staggeredInitQueue.shift();
    if (!slot) {
      return;
    }
    if (slot.isReady() || slot.isBusy() || slot.getInitError()) {
      this.scheduleNextStaggeredSlotInit();
      return;
    }
    this.staggeredInitActive = true;
    this.startSlotInit(slot)
      .catch((error) => {
        if (!this.destroyed) {
          console.warn("[Local Image Compress]", "Staggered worker initialization failed:", error);
        }
      })
      .finally(() => {
        this.staggeredInitActive = false;
        if (this.destroyed || this.staggeredInitQueue.length === 0) {
          return;
        }
        this.scheduleNextStaggeredSlotInit();
      });
  }

  private scheduleNextStaggeredSlotInit() {
    if (this.destroyed || this.staggeredInitTimer || this.staggeredInitQueue.length === 0) {
      return;
    }
    this.staggeredInitTimer = this.setWindowTimeout(() => {
      this.staggeredInitTimer = null;
      this.startNextStaggeredSlotInit();
    }, 0);
  }

  private startSlotInit(slot: WorkerSlot) {
    return slot.init().then(() => {
      this.enableInitRetryForFailedSlots();
      this.dispatchWaiters();
    }).catch(() => {
      this.enableInitRetryForFailedSlots();
      this.dispatchWaiters();
    });
  }

  private setWindowTimeout(callback: () => void, delay: number) {
    return window.setTimeout(callback, delay);
  }

  private clearWindowTimeout(timer: TimerHandle | null | undefined) {
    if (timer === null || timer === undefined) {
      return;
    }
    window.clearTimeout(timer as number);
  }

  private enableInitRetryForFailedSlots() {
    if (!this.slots.some((slot) => slot.isReady())) {
      return;
    }
    for (const slot of this.slots) {
      if (slot.getInitError()) {
        slot.allowInitRetry();
      }
    }
  }

  private findReadinessSlot() {
    const initializingSlot = this.slots.find((slot) => slot.isInitializing());
    if (initializingSlot) {
      return initializingSlot;
    }
    const recreateSlot = this.slots.find((slot) => slot.shouldRecreateOnDemand());
    if (recreateSlot) {
      return recreateSlot;
    }
    return this.slots.find((slot) => slot.canAcceptJob()) || null;
  }

  private acquireSlot(): Promise<WorkerSlot> {
    if (this.destroyed) {
      return Promise.reject(this.getInitError() ?? new Error("Compressor worker stopped"));
    }
    const slot = this.findAndReserveSlot();
    if (slot) {
      return Promise.resolve(slot);
    }
    const initError = this.getInitError();
    if (initError) {
      return Promise.reject(initError);
    }
    if (this.waiters.length >= this.MAX_WAITERS) {
      return Promise.reject(new Error(`Worker pool waiters queue full (${this.MAX_WAITERS})`));
    }
    return new Promise<WorkerSlot>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private findAndReserveSlot() {
    const readySlot = this.slots.find((slot) => slot.isReady() && slot.canAcceptJob());
    if (readySlot?.tryReserve()) {
      return readySlot;
    }
    const recreateSlot = this.slots.find((slot) => slot.shouldRecreateOnDemand());
    if (recreateSlot?.tryReserve()) {
      return recreateSlot;
    }
    const coldSlot = this.slots.find((slot) => slot.canAcceptJob());
    if (coldSlot?.tryReserve()) {
      return coldSlot;
    }
    return null;
  }

  private dispatchWaiters() {
    while (this.waiters.length > 0) {
      if (this.destroyed) {
        const error = this.getInitError();
        for (const waiter of this.waiters.splice(0)) {
          waiter.reject(error);
        }
        return;
      }
      const slot = this.findAndReserveSlot();
      if (!slot) {
        const initError = this.getInitError();
        if (initError) {
          for (const waiter of this.waiters.splice(0)) {
            waiter.reject(initError);
          }
        }
        return;
      }
      const waiter = this.waiters.shift();
      waiter?.resolve(slot);
    }
  }
}
