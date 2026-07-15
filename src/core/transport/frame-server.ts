import {
  FrameLimitExceededError,
  LengthPrefixedFrameDecoder,
} from './length-prefixed-frame-decoder';
import { TokenBucket } from './token-bucket';

/**
 * Opt-in Bun-native TCP framing server that composes the two primitives above:
 * bounded reassembly (non-recursive, byte-capped) + per-connection token-bucket
 * backpressure. The `data` handler is a flat loop, preserving the O(1) parse
 * depth guarantee end to end — a malformed/oversized frame or an over-budget
 * peer is dropped (socket end), never allowed to drive recursion or allocation.
 *
 * This is a FACTORY: nothing binds a port at import time. Call
 * `createFrameServer(...)` from a composition root when you actually want a raw
 * TCP transport. For most services the HTTP edge is enough and you never touch
 * this — it exists so that IF you build a custom TCP protocol, it is bounded by
 * construction rather than exposed to the CVE-2026-40879 class.
 */

export interface FrameServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly maxFrameBytes: number;
  readonly maxBufferBytes: number;
  readonly capacity: number;
  readonly refillPerSecond: number;
  /** Application logic for one validated, rate-limited frame. */
  readonly onFrame: (payload: Buffer) => void;
}

interface ConnState {
  readonly decoder: LengthPrefixedFrameDecoder;
  readonly bucket: TokenBucket;
}

export function createFrameServer(opts: FrameServerOptions) {
  return Bun.listen<ConnState>({
    hostname: opts.hostname,
    port: opts.port,
    socket: {
      open(socket) {
        socket.data = {
          decoder: new LengthPrefixedFrameDecoder({
            maxFrameBytes: opts.maxFrameBytes,
            maxBufferBytes: opts.maxBufferBytes,
          }),
          bucket: new TokenBucket({
            capacity: opts.capacity,
            refillPerSecond: opts.refillPerSecond,
          }),
        };
      },
      data(socket, chunk) {
        const { decoder, bucket } = socket.data;
        let frames: Buffer[];
        try {
          frames = decoder.push(chunk); // throws on frame/buffer cap violation
        } catch (error) {
          if (error instanceof FrameLimitExceededError) {
            socket.end(); // malformed or oversized => drop, fail loud
            return;
          }
          throw error;
        }
        for (const frame of frames) {
          if (!bucket.tryRemove(1)) {
            socket.end(); // over rate budget => backpressure by disconnect
            return;
          }
          opts.onFrame(frame);
        }
      },
      error(socket) {
        socket.end();
      },
    },
  });
}
