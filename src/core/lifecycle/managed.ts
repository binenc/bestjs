import { Injectable } from '@nestjs/common';
import type { Observable, Subscription } from 'rxjs';
import { ResourceRegistry, type ResourceHandle } from './resource-registry';

interface Emitterish<E extends string> {
  on(event: E, listener: (...args: never[]) => void): unknown;
  off(event: E, listener: (...args: never[]) => void): unknown;
}

/**
 * Managed — the ONLY ergonomic way to create long-lived timers, listeners, and
 * subscriptions. Each helper registers its own teardown in the same expression,
 * so an un-owned resource is not something this API can produce. This is Rust's
 * move of a constructor returning an owned value whose Drop is already wired:
 * "remember to clearInterval" stops being a discipline you can forget and
 * becomes a guarantee of the type.
 *
 * Prefer these over raw setInterval / emitter.on / observable.subscribe. An
 * eslint rule (`no-restricted-globals`/`no-restricted-syntax`) can forbid the
 * raw forms outright to make the leak physically unreachable.
 */
@Injectable()
export class Managed {
  constructor(private readonly registry: ResourceRegistry) {}

  setInterval(label: string, ms: number, fn: () => void): ResourceHandle {
    const id = setInterval(fn, ms);
    id.unref?.();
    return this.registry.register(`interval:${label}`, () => {
      clearInterval(id);
    });
  }

  setTimeout(label: string, ms: number, fn: () => void): ResourceHandle {
    const id = setTimeout(fn, ms);
    id.unref?.();
    return this.registry.register(`timeout:${label}`, () => {
      clearTimeout(id);
    });
  }

  on<E extends string>(
    label: string,
    target: Emitterish<E>,
    event: E,
    listener: (...args: never[]) => void,
  ): ResourceHandle {
    target.on(event, listener);
    return this.registry.register(`listener:${label}:${event}`, () => {
      target.off(event, listener);
    });
  }

  subscribe<T>(label: string, source: Observable<T>, next: (value: T) => void): ResourceHandle {
    const sub: Subscription = source.subscribe(next);
    return this.registry.register(`subscription:${label}`, () => {
      sub.unsubscribe();
    });
  }
}
