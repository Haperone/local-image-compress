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
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.releaseNext();
    }
  }

  private releaseNext() {
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    Promise.resolve()
      .then(next)
      .catch(() => {
        this.releaseNext();
      });
  }

  private static isValidLimit(limit: number) {
    return Number.isInteger(limit) && limit >= 1;
  }
}
