import { describe, expect, it } from 'bun:test';
import {
  FrameLimitExceededError,
  LengthPrefixedFrameDecoder,
} from '../src/core/transport/length-prefixed-frame-decoder';

function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

describe('LengthPrefixedFrameDecoder', () => {
  it('decodes many frames from a single chunk WITHOUT recursion (CVE-2026-40879 class)', () => {
    const dec = new LengthPrefixedFrameDecoder({ maxFrameBytes: 1024, maxBufferBytes: 1 << 20 });
    // 50k tiny frames in one segment would blow a recursive handler's stack.
    const parts: Buffer[] = [];
    for (let i = 0; i < 50_000; i++) parts.push(frame('x'));
    const frames = dec.push(Buffer.concat(parts));
    expect(frames.length).toBe(50_000);
    expect(dec.pendingBytes).toBe(0);
  });

  it('reassembles a frame split across chunks', () => {
    const dec = new LengthPrefixedFrameDecoder({ maxFrameBytes: 1024, maxBufferBytes: 1 << 20 });
    const whole = frame('hello world');
    expect(dec.push(whole.subarray(0, 3))).toEqual([]);
    expect(dec.push(whole.subarray(3))).toEqual([Buffer.from('hello world')]);
  });

  it('rejects an over-large length prefix BEFORE allocating', () => {
    const dec = new LengthPrefixedFrameDecoder({ maxFrameBytes: 8, maxBufferBytes: 1024 });
    const lying = Buffer.alloc(4);
    lying.writeUInt32BE(0xffffffff, 0); // claims 4 GiB
    expect(() => dec.push(lying)).toThrow(FrameLimitExceededError);
  });

  it('rejects unbounded reassembly growth', () => {
    const dec = new LengthPrefixedFrameDecoder({ maxFrameBytes: 8, maxBufferBytes: 16 });
    // Header says 8 bytes, but we keep feeding without completing — buffer cap trips.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(8, 0);
    dec.push(header);
    expect(() => dec.push(Buffer.alloc(20))).toThrow(FrameLimitExceededError);
  });

  it('enforces the constructor invariant', () => {
    expect(() => new LengthPrefixedFrameDecoder({ maxFrameBytes: 100, maxBufferBytes: 50 })).toThrow(
      RangeError,
    );
  });
});
