import { describe, expect, it } from 'bun:test';
import { TokenBucket } from '../src/core/transport/token-bucket';

describe('TokenBucket (message-flood backpressure)', () => {
  it('allows a burst up to capacity, then refuses', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, () => now);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false); // burst exhausted
  });

  it('refills over elapsed wall-clock, deterministically (no timers)', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 10 }, () => now);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
    now = 100; // 100ms at 10/s => +1 token
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('never exceeds capacity no matter how long it idles', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1000 }, () => now);
    now = 10_000; // huge idle
    let granted = 0;
    while (bucket.tryRemove()) granted++;
    expect(granted).toBe(5); // capped at capacity, not 10_000_000
  });
});
