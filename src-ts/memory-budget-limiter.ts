type MemoryWaiter = {
  weight: number;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

export type MemoryBudgetReservation = {
  resize(requestedWeight: number): Promise<void>;
  release(): void;
};

export class MemoryBudgetLimiter {
  private activeWeight = 0;
  private readonly waiters: MemoryWaiter[] = [];
  private destroyedError: Error | null = null;

  constructor(private readonly budget: number) {
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error("Memory budget must be a positive finite number");
    }
  }

  async run<T>(requestedWeight: number, task: () => Promise<T>): Promise<T> {
    const reservation = await this.reserve(requestedWeight);
    try {
      return await task();
    } finally {
      reservation.release();
    }
  }

  async reserve(requestedWeight: number): Promise<MemoryBudgetReservation> {
    let heldWeight = this.normalizeWeight(requestedWeight);
    let released = false;
    await this.acquire(heldWeight);
    return {
      resize: async (nextRequestedWeight: number) => {
        if (released) {
          throw new Error("Memory reservation was already released");
        }
        const nextWeight = this.normalizeWeight(nextRequestedWeight);
        if (nextWeight > heldWeight) {
          await this.acquire(nextWeight - heldWeight);
        } else if (nextWeight < heldWeight) {
          this.release(heldWeight - nextWeight);
        }
        heldWeight = nextWeight;
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.release(heldWeight);
      }
    };
  }

  destroy(error: Error) {
    this.destroyedError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private normalizeWeight(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      return this.budget;
    }
    return Math.min(this.budget, Math.ceil(value));
  }

  private acquire(weight: number): Promise<void> {
    if (this.destroyedError) {
      return Promise.reject(this.destroyedError);
    }
    if (this.waiters.length === 0 && this.activeWeight + weight <= this.budget) {
      this.activeWeight += weight;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ weight, resolve, reject });
    });
  }

  private release(weight: number) {
    this.activeWeight = Math.max(0, this.activeWeight - weight);
    this.dispatchWaiters();
  }

  private dispatchWaiters() {
    while (!this.destroyedError) {
      const waiter = this.waiters[0];
      if (!waiter || this.activeWeight + waiter.weight > this.budget) {
        return;
      }
      this.waiters.shift();
      this.activeWeight += waiter.weight;
      waiter.resolve();
    }
  }
}
