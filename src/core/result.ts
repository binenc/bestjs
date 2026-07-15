/**
 * Result<T, E> — errors as values, not surprises.
 *
 * Borrowed from Rust: a function that can fail says so in its return type. The
 * caller cannot reach the success value without acknowledging the error branch,
 * because `ok` narrows the union. There is no hidden `throw` control-flow: a
 * `Result`-returning function never throws for *expected* failures.
 *
 * Use `Result` for expected, recoverable domain failures (not-found, conflict,
 * validation). Reserve `throw` for truly exceptional, unrecoverable faults
 * (programmer bugs, OOM) — those are caught once, at the edge, by the global
 * exception filter.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Type guards for when you want to branch without destructuring. */
export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Map the success value, leaving an error untouched. */
export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Map the error value, leaving success untouched. */
export function mapErr<T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(fn(r.error));
}

/** Chain a fallible operation; short-circuits on the first error. */
export function andThen<T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

/** Extract the value or supply a fallback — never throws. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * Extract the value or throw. Use ONLY at boundaries where an error is a bug
 * (e.g. after you've already validated). The thrown value is the error itself,
 * so the exception filter can still classify it.
 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw r.error;
}

/**
 * Wrap a throwing/async operation into a Result, so third-party code that
 * throws is normalized into the errors-as-values world at its boundary.
 */
export async function fromPromise<T, E>(
  promise: Promise<T>,
  onError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (cause) {
    return err(onError(cause));
  }
}

/** Synchronous sibling of {@link fromPromise}. */
export function fromThrowable<T, E>(fn: () => T, onError: (cause: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(onError(cause));
  }
}
