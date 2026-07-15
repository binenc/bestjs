import { describe, expect, it } from 'bun:test';
import { canonicalizePath, foldMethod } from '../src/core/http/canonical-url.middleware';

describe('canonicalizePath (CVE-2025-69211 encoding-bypass class)', () => {
  it('decodes %61 so /%61dmin and /admin canonicalize identically', () => {
    const a = canonicalizePath('/%61dmin');
    const b = canonicalizePath('/admin');
    expect(a).toEqual({ ok: true, path: '/admin' });
    expect(b).toEqual({ ok: true, path: '/admin' });
  });

  it('rejects double-encoding (%2561 -> %61 leaves a residual %)', () => {
    expect(canonicalizePath('/%2561dmin')).toEqual({ ok: false, reason: 'multi-encoded path' });
  });

  it('strips trailing slash so /admin/ === /admin', () => {
    expect(canonicalizePath('/admin/')).toEqual({ ok: true, path: '/admin' });
  });

  it('removes dot-segments and blocks traversal above root', () => {
    expect(canonicalizePath('/a/./b/../c')).toEqual({ ok: true, path: '/a/c' });
    expect(canonicalizePath('/../etc/passwd')).toEqual({
      ok: false,
      reason: 'path traversal above root',
    });
  });

  it('rejects backslash and control characters', () => {
    expect(canonicalizePath('/admin\\x').ok).toBe(false);
    expect(canonicalizePath('/admin\x00').ok).toBe(false);
  });

  it('rejects malformed percent-encoding', () => {
    expect(canonicalizePath('/%zz')).toEqual({ ok: false, reason: 'malformed percent-encoding' });
  });
});

describe('foldMethod (CVE-2026-33011 HEAD-bypass class)', () => {
  it('folds HEAD to GET so HEAD cannot bypass a GET auth check', () => {
    expect(foldMethod('HEAD')).toBe('GET');
    expect(foldMethod('GET')).toBe('GET');
  });

  it('rejects unknown methods', () => {
    expect(foldMethod('TRACE')).toBeNull();
  });
});
