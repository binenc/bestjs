/**
 * Iterative length-prefixed frame decoder — O(1) parse depth, hard byte caps.
 *
 * Framing: [u32 big-endian payload length][payload bytes].
 *
 * Confirmed failure class (CVE-2026-40879, @nestjs/microservices TCP transport):
 * a handler that re-enters itself once per message turns a burst of tiny frames
 * in a single TCP segment into unbounded call-stack depth → stack overflow and
 * process crash. A stream that never completes a frame instead grows the
 * reassembly buffer without bound → OOM. A 32-bit length prefix claiming 4 GiB
 * pre-allocates 4 GiB.
 *
 * This decoder makes those states unrepresentable at the loop level: it is a
 * flat state machine with one monotonically-advancing cursor and a single
 * forward `while` loop — there is NO self-call, so parse depth is O(1) no matter
 * how many frames arrive in one chunk. Two hard caps are enforced: an over-large
 * length prefix is rejected by comparing the integer to the cap BEFORE any
 * allocation, and reassembly can never exceed the buffer cap because `push`
 * rejects the moment pending bytes would. Frame payloads are copied out so a
 * retained frame never pins the whole accumulator.
 */

const HEADER_BYTES = 4;

export interface FrameDecoderOptions {
  /** Hard cap on a single frame's payload. A larger declared length is rejected pre-allocation. */
  readonly maxFrameBytes: number;
  /** Hard cap on unparsed bytes held in reassembly. Prevents unbounded buffer growth. */
  readonly maxBufferBytes: number;
}

export class FrameLimitExceededError extends Error {
  constructor(
    readonly kind: 'frame' | 'buffer',
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`frame decoder ${kind} limit exceeded: limit=${String(limit)} actual=${String(actual)}`);
    this.name = 'FrameLimitExceededError';
  }
}

export class LengthPrefixedFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private start = 0; // read cursor; only ever advances within `buf`
  private readonly maxFrameBytes: number;
  private readonly maxBufferBytes: number;

  constructor(opts: FrameDecoderOptions) {
    // Invariant checked once: the buffer must be able to hold at least one full frame.
    if (opts.maxFrameBytes <= 0 || !Number.isInteger(opts.maxFrameBytes)) {
      throw new RangeError('maxFrameBytes must be a positive integer');
    }
    if (opts.maxBufferBytes < opts.maxFrameBytes + HEADER_BYTES) {
      throw new RangeError('maxBufferBytes must be >= maxFrameBytes + header');
    }
    this.maxFrameBytes = opts.maxFrameBytes;
    this.maxBufferBytes = opts.maxBufferBytes;
  }

  /** Feed a chunk; returns zero or more complete frame payloads (copies). Throws on cap violation. */
  push(chunk: Buffer): Buffer[] {
    const pending = this.buf.length - this.start;
    if (pending + chunk.length > this.maxBufferBytes) {
      throw new FrameLimitExceededError('buffer', this.maxBufferBytes, pending + chunk.length);
    }
    // Compact the consumed prefix, then append. Kept memory is bounded by maxBufferBytes.
    if (this.start > 0) {
      this.buf = this.buf.subarray(this.start);
      this.start = 0;
    }
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    return this.drain();
  }

  // Single forward pass. No recursion: each iteration strictly advances `start`.
  private drain(): Buffer[] {
    const frames: Buffer[] = [];
    for (;;) {
      const available = this.buf.length - this.start;
      if (available < HEADER_BYTES) break;
      const len = this.buf.readUInt32BE(this.start);
      if (len > this.maxFrameBytes) {
        // Reject BEFORE allocating; a lying length prefix can never drive allocation.
        throw new FrameLimitExceededError('frame', this.maxFrameBytes, len);
      }
      if (available < HEADER_BYTES + len) break; // wait for more bytes
      const from = this.start + HEADER_BYTES;
      // Copy so a retained frame does not pin the whole accumulator.
      frames.push(Buffer.from(this.buf.subarray(from, from + len)));
      this.start = from + len;
    }
    return frames;
  }

  /** Bytes currently buffered but not yet forming a complete frame. */
  get pendingBytes(): number {
    return this.buf.length - this.start;
  }
}
