import {
  MODULE_METADATA,
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import type { DynamicModule, ForwardReference, Provider, Type } from '@nestjs/common';

/**
 * Static provider dependency-cycle detector — kills the silent DI hang before it
 * can happen.
 *
 * Real, confirmed failure class (nestjs/nest#11630): two providers that depend
 * on each other, wired with `forwardRef()` to satisfy the type checker, make
 * Nest either inject a partially-constructed `undefined` or DEADLOCK during
 * instantiation with no error at all. `forwardRef` is exactly where the cycle
 * becomes invisible to both the compiler and Nest's own eager checks.
 *
 * Before we ask Nest to build anything, we walk the module tree from the root
 * using Nest's own metadata keys, unwrap every `forwardRef`, build the provider
 * dependency graph, and run Tarjan's strongly-connected-components algorithm.
 * Any SCC larger than one node (or a self-loop) is a cycle. This is a pure,
 * fast, side-effect-free check that cannot itself hang — it turns a 3am
 * never-resolving startup into a loud crash naming the exact provider chain.
 */

export type ModuleDefinition = Type<unknown> | ForwardReference | DynamicModule;
type Token = Type<unknown> | string | symbol;

// `design:paramtypes` emits these for untyped / @Inject'd params; not real nodes.
const OPAQUE = new Set<unknown>([Object, Function, String, Number, Boolean, Array]);
const isToken = (t: Token | undefined): t is Token => t != null && !OPAQUE.has(t);

function unwrap(t: unknown): Token | undefined {
  if (t == null) return undefined;
  if (typeof t === 'object' && 'forwardRef' in t) {
    return unwrap((t as ForwardReference).forwardRef());
  }
  return t as Token;
}

function tokenName(t: unknown): string {
  const u = unwrap(t);
  if (u == null) return '<unknown>';
  if (typeof u === 'function') return u.name || '<anonymous>';
  if (typeof u === 'symbol') return u.toString();
  return `'${String(u)}'`;
}

function unwrapModule(raw: unknown): ModuleDefinition | undefined {
  if (raw == null || raw instanceof Promise) return undefined; // async imports: not statically inspectable
  if (typeof raw === 'object' && 'forwardRef' in raw) {
    return unwrapModule((raw as ForwardReference).forwardRef());
  }
  return raw as ModuleDefinition;
}

function classDeps(cls: Type<unknown>): Token[] {
  const paramtypes = (Reflect.getMetadata(PARAMTYPES_METADATA, cls) ?? []) as unknown[];
  const selfDeps = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) ?? []) as Array<{
    index: number;
    param: unknown;
  }>;
  const optional = (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls) ?? []) as Array<{
    index: number;
  }>;
  const optionalIdx = new Set(optional.map((o) => o.index));

  const n = Math.max(paramtypes.length, ...selfDeps.map((d) => d.index + 1), 0);
  const resolved: Array<Token | undefined> = [];
  for (let i = 0; i < n; i++) resolved.push(unwrap(paramtypes[i]));
  for (const d of selfDeps) resolved[d.index] = unwrap(d.param); // @Inject(forwardRef(...)) lives here

  return resolved.map((t, i) => (optionalIdx.has(i) ? undefined : t)).filter(isToken);
}

function fromInjectItem(item: unknown): Token | undefined {
  if (item != null && typeof item === 'object' && 'token' in item) {
    if ((item as { optional?: boolean }).optional) return undefined;
    return unwrap((item as { token: unknown }).token);
  }
  return unwrap(item);
}

function providerToken(p: Provider): Token | undefined {
  if (typeof p === 'function') return p;
  return unwrap(p.provide);
}

function providerDeps(p: Provider): Token[] {
  if (typeof p === 'function') return classDeps(p);
  if ('useClass' in p) return classDeps(p.useClass);
  if ('useFactory' in p) return (p.inject ?? []).map(fromInjectItem).filter(isToken);
  if ('useExisting' in p) return [unwrap(p.useExisting)].filter(isToken);
  return []; // useValue: no construction dependencies
}

function collectProviders(root: ModuleDefinition): Provider[] {
  const seen = new Set<unknown>();
  const out: Provider[] = [];
  const queue: unknown[] = [root];
  while (queue.length) {
    const mod = unwrapModule(queue.pop());
    if (!mod) continue;
    const isDynamic = typeof mod === 'object' && 'module' in mod;
    const cls = isDynamic ? (mod as DynamicModule).module : (mod as Type<unknown>);
    if (seen.has(cls)) continue;
    seen.add(cls);

    for (const p of (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, cls) ?? []) as Provider[]) {
      out.push(p);
    }
    for (const i of (Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) ?? []) as unknown[]) {
      queue.push(i);
    }
    if (isDynamic) {
      const dyn = mod as DynamicModule;
      for (const p of dyn.providers ?? []) out.push(p);
      for (const i of dyn.imports ?? []) queue.push(i);
    }
  }
  return out;
}

export interface DependencyCycle {
  readonly members: string[];
}

export function findDependencyCycles(root: ModuleDefinition): DependencyCycle[] {
  const edges = new Map<Token, Set<Token>>();
  const ensure = (t: Token): Set<Token> => {
    let s = edges.get(t);
    if (!s) edges.set(t, (s = new Set()));
    return s;
  };
  for (const p of collectProviders(root)) {
    const from = providerToken(p);
    if (!isToken(from)) continue;
    const set = ensure(from);
    for (const dep of providerDeps(p)) {
      ensure(dep);
      set.add(dep);
    }
  }
  return tarjan(edges).map((scc) => ({ members: scc.map(tokenName) }));
}

/** Tarjan's SCC. Returns only components that are cycles (size > 1, or a self-loop). */
function tarjan(edges: Map<Token, Set<Token>>): Token[][] {
  let index = 0;
  const idx = new Map<Token, number>();
  const low = new Map<Token, number>();
  const onStack = new Set<Token>();
  const stack: Token[] = [];
  const sccs: Token[][] = [];

  const connect = (v: Token): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: Token[] = [];
      let w: Token;
      do {
        w = stack.pop() as Token;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      const first = comp[0];
      const selfLoop = comp.length === 1 && first !== undefined && (edges.get(first)?.has(first) ?? false);
      if (comp.length > 1 || selfLoop) sccs.push(comp);
    }
  };

  for (const v of edges.keys()) if (!idx.has(v)) connect(v);
  return sccs;
}

/** Bootstrap gate: panic with the exact provider chain if any cycle exists. */
export function assertNoDependencyCycles(root: ModuleDefinition): void {
  const cycles = findDependencyCycles(root);
  if (cycles.length === 0) return;
  const lines = [
    '✗ Provider dependency cycle(s) detected — refusing to start.',
    '',
    ...cycles.map((c, i) => {
      const first = c.members[0] ?? '?';
      return `  cycle #${i + 1}: ${[...c.members, first].join(' → ')}`;
    }),
    '',
    '  Nest papers over these with forwardRef() and then injects `undefined` or',
    '  hangs during construction. Break the cycle: extract a shared provider,',
    '  invert a dependency, or communicate via an event/queue instead of a ref.',
  ];
  process.stderr.write(`\n${lines.join('\n')}\n\n`);
  process.exit(70); // EX_SOFTWARE
}
