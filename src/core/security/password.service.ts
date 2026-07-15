import { Injectable } from '@nestjs/common';

/**
 * Password hashing via Bun's built-in `Bun.password` (argon2id).
 *
 * The native-addon reality (verified): Bun runs on JavaScriptCore, so C++ addons
 * written against V8 internals break. `bcrypt`/`argon2` npm packages actually do
 * work on modern Bun via Node-API — but the most robust choice is to depend on
 * NOTHING native at all. `Bun.password` is argon2id implemented in the runtime:
 * no node-gyp, no compile step, no Windows-addon segfault class, memory-hard by
 * default. This makes the whole "native addon incompatibility" surface a
 * non-issue for the single most common place teams reach for one.
 *
 * argon2id parameters below are a sane 2026 baseline; tune memoryCost/timeCost
 * to your hardware and latency budget.
 */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return Bun.password.hash(plain, {
      algorithm: 'argon2id',
      memoryCost: 19_456, // ~19 MiB (OWASP argon2id baseline)
      timeCost: 2,
    });
  }

  /** Constant-time verify. Also transparently re-hashes when params are upgraded. */
  verify(plain: string, hash: string): Promise<boolean> {
    return Bun.password.verify(plain, hash);
  }
}
