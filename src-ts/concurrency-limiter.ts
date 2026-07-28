export class ConcurrencyLimiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit = 1) {
    if (!ConcurrencyLimiter.isValidLimit(limit)) {
      throw new RangeError(`ConcurrencyLimiter limit must be a positive integer, got: ${limit}`);
    }
    this.limit = limit;
  }

  getLimit() {
    return this.limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (!ConcurrencyLimiter.isValidLimit(this.limit)) {
      throw new Error(`ConcurrencyLimiter is in an invalid state: limit=${this.limit}`);
    }
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      this.releaseNext();
    }
  }

  private releaseNext() {
    const next = this.queue.shift();
    if (next) {
      try {
        next();
      } catch (error) {
        console.warn("[Local Image Compress] Failed to transfer a concurrency permit:", error);
        this.releaseNext();
      }
      return;
    }
    this.active--;
  }

  private static isValidLimit(limit: number) {
    return Number.isInteger(limit) && limit >= 1;
  }
}
