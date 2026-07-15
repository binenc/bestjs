/**
 * TokenBucket — lazy, timer-free per-connection backpressure.
 *
 * The message-flood class: a connection that passed connect-time checks can
 * still emit millions of small valid frames per second, saturating the event
 * loop and starving other tenants. Naive fixes use a setInterval per connection
 * (thousands of timers) or a single global counter (one abuser degrades
 * everyone).
 *
 * This bucket recomputes available tokens from elapsed wall-clock ONLY when a
 * message arrives — zero timers, O(1) work per frame regardless of connection
 * count. Each connection owns its own bucket, so backpressure is isolated: one
 * peer draining its budget cannot touch another's. `capacity` bounds burst;
 * `refillPerSecond` bounds sustained rate. When the bucket is empty the caller
 * drops the abuser (close the socket) rather than the fleet.
 *
 * A monotonic clock is injectable so the logic is deterministically testable
 * without any dependence on `Date.now()` / `performance.now()` in tests.
 */

export interface RateLimitOptions {
  /** Max burst (bucket size). */
  readonly capacity: number;
  /** Sustained tokens added per second. */
  readonly refillPerSecond: number;
}

export type Clock = () => number;

export class TokenBucket {
  private tokens: number;
  private lastMs: number;
  private readonly capacity: number;
  private readonly ratePerMs: number;
  private readonly now: Clock;

  constructor(opts: RateLimitOptions, now: Clock = () => performance.now()) {
    if (opts.capacity <= 0 || opts.refillPerSecond <= 0) {
      throw new RangeError('capacity and refillPerSecond must be positive');
    }
    this.capacity = opts.capacity;
    this.ratePerMs = opts.refillPerSecond / 1000;
    this.tokens = opts.capacity;
    this.now = now;
    this.lastMs = now();
  }

  /** O(1), no timers: refill is derived from elapsed time at call time. */
  tryRemove(count = 1): boolean {
    const nowMs = this.now();
    const elapsed = nowMs - this.lastMs;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
      this.lastMs = nowMs;
    }
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  get available(): number {
    return this.tokens;
  }
}
