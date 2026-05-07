import { describe, it, expect } from 'vitest';
import { humanSize, escapeHtml } from './utils.js';

describe('humanSize', () => {
  it('renders bytes under 1KiB as plain bytes', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1)).toBe('1 B');
    expect(humanSize(1023)).toBe('1023 B');
  });

  it('renders KiB with 1 decimal between 1KiB and 1MiB', () => {
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(1024 * 1023)).toBe('1023.0 KB');
  });

  it('renders MiB with 1 decimal at 1MiB and above', () => {
    expect(humanSize(1024 * 1024)).toBe('1.0 MB');
    expect(humanSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(humanSize(50 * 1024 * 1024)).toBe('50.0 MB');
  });
});

describe('escapeHtml', () => {
  it('escapes the five canonical HTML special chars', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes them in context', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml("Tom & Jerry's <Adventure>"))
      .toBe('Tom &amp; Jerry&#39;s &lt;Adventure&gt;');
  });

  it('leaves non-special characters alone', () => {
    expect(escapeHtml('Plain ASCII text')).toBe('Plain ASCII text');
    expect(escapeHtml('Café — 你好 — Привет')).toBe('Café — 你好 — Привет');
  });

  it('double-escapes ampersands in already-escaped entities (NOT idempotent)', () => {
    // Documenting current behaviour: re-running escapeHtml on its own output
    // re-escapes the & in entities (so &lt; → &amp;lt;). If output ever
    // becomes byte-idempotent that's a behaviour change, not a bugfix.
    const once = escapeHtml('<a href="x">');
    const twice = escapeHtml(once);
    expect(twice).toContain('&amp;lt;');
  });
});
