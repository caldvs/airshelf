import { describe, it, expect } from 'vitest';
import {
  searchOpenLibrary,
  downloadOpenLibraryCover,
  fetchOpenLibraryDescription,
  buildSearchVariants,
  scoreDoc,
  pickBestDoc,
  buildCoverAttemptUrls,
  parseDescription,
  COVER_PLACEHOLDER_BYTES,
} from './out/integrations/openlibrary.js';

// Note: openlibrary.js exports `searchOpenLibrary` and
// `downloadOpenLibraryCover` separately rather than the
// `fetchCoverFromOpenLibrary` composite helper. main.js wants the doc
// from the search step for description fetching too, so the composite
// would always lose information. Tests cover the two halves
// individually below.

// ---- Pure helpers ----

describe('buildSearchVariants', () => {
  it('returns the cleaned title first', () => {
    const variants = buildSearchVariants('The Hobbit (Annotated).epub');
    expect(variants[0]).toBe('The Hobbit');
  });

  it('adds a colon-prefix variant when the cleaned title contains a colon', () => {
    expect(buildSearchVariants('Sapiens: A Brief History of Humankind')).toContain('Sapiens');
  });

  it('falls back to the raw title alongside the cleaned one', () => {
    const variants = buildSearchVariants('foo_bar.epub');
    // Both 'foo bar' (cleaned) and 'foo_bar.epub' (raw) — cleaned first.
    expect(variants).toContain('foo bar');
    expect(variants).toContain('foo_bar.epub');
  });

  it('deduplicates when cleaned == raw', () => {
    const variants = buildSearchVariants('Dune');
    expect(variants).toEqual(['Dune']);
  });

  it('drops variants shorter than 2 characters', () => {
    // 'a.epub' cleans to 'a' — too short to query, dropped.
    expect(buildSearchVariants('a.epub')).toEqual(['a.epub']);
  });

  it('returns an empty array for empty input', () => {
    expect(buildSearchVariants('')).toEqual([]);
  });
});

describe('scoreDoc', () => {
  it('English + cover = 3 (max)', () => {
    expect(scoreDoc({ language: ['eng'], cover_i: 42 })).toBe(3);
  });

  it('English without cover = 2', () => {
    expect(scoreDoc({ language: ['eng'] })).toBe(2);
  });

  it('non-English with cover = 1', () => {
    expect(scoreDoc({ language: ['fre'], cover_i: 42 })).toBe(1);
  });

  it('non-English without cover = 0', () => {
    expect(scoreDoc({ language: ['fre'] })).toBe(0);
  });

  it('treats missing language as non-English', () => {
    expect(scoreDoc({ cover_i: 42 })).toBe(1);
    expect(scoreDoc({})).toBe(0);
  });
});

describe('pickBestDoc', () => {
  it('returns null for empty input', () => {
    expect(pickBestDoc([])).toBeNull();
    expect(pickBestDoc(null)).toBeNull();
  });

  it('returns the highest-scoring doc', () => {
    const docs = [
      { title: 'A', language: ['fre'] }, // 0
      { title: 'B', language: ['eng'] }, // 2
      { title: 'C', language: ['eng'], cover_i: 1 }, // 3
      { title: 'D', language: ['fre'], cover_i: 1 }, // 1
    ];
    expect(pickBestDoc(docs).title).toBe('C');
  });

  it('returns the FIRST doc that hits the max score (3)', () => {
    const docs = [
      { title: 'first-3', language: ['eng'], cover_i: 1 },
      { title: 'second-3', language: ['eng'], cover_i: 2 },
    ];
    expect(pickBestDoc(docs).title).toBe('first-3');
  });

  it('returns the first doc when all docs are equal', () => {
    const docs = [{ title: 'a' }, { title: 'b' }];
    expect(pickBestDoc(docs).title).toBe('a');
  });
});

describe('buildCoverAttemptUrls', () => {
  it('returns empty for null doc', () => {
    expect(buildCoverAttemptUrls(null)).toEqual([]);
  });

  it('returns empty for a doc with no identifiers', () => {
    expect(buildCoverAttemptUrls({})).toEqual([]);
  });

  it('emits cover_i first, then ISBN, then OLID', () => {
    const urls = buildCoverAttemptUrls({
      cover_i: 12345,
      isbn: ['9780000000001'],
      edition_key: ['OL999M'],
    });
    expect(urls).toEqual([
      'https://covers.openlibrary.org/b/id/12345-L.jpg',
      'https://covers.openlibrary.org/b/isbn/9780000000001-L.jpg',
      'https://covers.openlibrary.org/b/olid/OL999M-L.jpg',
    ]);
  });

  it('skips identifiers not present', () => {
    expect(buildCoverAttemptUrls({ cover_i: 1 })).toEqual([
      'https://covers.openlibrary.org/b/id/1-L.jpg',
    ]);
    expect(buildCoverAttemptUrls({ isbn: ['9780000000001'] })).toEqual([
      'https://covers.openlibrary.org/b/isbn/9780000000001-L.jpg',
    ]);
  });
});

describe('parseDescription', () => {
  it('returns null for missing input', () => {
    expect(parseDescription(null)).toBeNull();
    expect(parseDescription({})).toBeNull();
    expect(parseDescription({ description: null })).toBeNull();
  });

  it('returns the string when description is a plain string', () => {
    expect(parseDescription({ description: 'A novel.' })).toBe('A novel.');
  });

  it('returns the .value when description is the typed object form', () => {
    expect(
      parseDescription({
        description: { type: '/type/text', value: 'A novel.' },
      }),
    ).toBe('A novel.');
  });

  it('returns null for unrecognised shapes', () => {
    expect(parseDescription({ description: 42 })).toBeNull();
    expect(parseDescription({ description: ['a', 'b'] })).toBeNull();
    expect(parseDescription({ description: { type: '/type/text' } })).toBeNull();
  });
});

// ---- Stubbed network helpers ----

function mockOk(body) {
  return {
    ok: true,
    json: async () => body,
    arrayBuffer: async () => Buffer.from(body),
    headers: { get: () => null },
  };
}

function mockBytes(byteLength) {
  return {
    ok: true,
    arrayBuffer: async () => new Uint8Array(byteLength).buffer,
  };
}

describe('searchOpenLibrary', () => {
  it('returns null for empty title without hitting the network', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return mockOk({ docs: [] });
    };
    expect(await searchOpenLibrary('', null, { fetch: fetchFn })).toBeNull();
    expect(calls).toBe(0);
  });

  it('returns the best-scoring doc across docs returned by the first variant', async () => {
    const docs = [
      { title: 'mid', language: ['eng'] }, // 2
      { title: 'top', language: ['eng'], cover_i: 1 }, // 3 — short-circuit hit
    ];
    const fetchFn = async () => mockOk({ docs });
    const result = await searchOpenLibrary('Foo', null, { fetch: fetchFn });
    expect(result.title).toBe('top');
  });

  it('skips a variant whose response is not ok', async () => {
    let call = 0;
    const fetchFn = async () => {
      call++;
      if (call === 1) return { ok: false };
      return mockOk({ docs: [{ title: 'fallback', language: ['eng'] }] });
    };
    // Use a colon title so two variants get tried.
    const result = await searchOpenLibrary('Sapiens: Subtitle', null, { fetch: fetchFn });
    expect(result.title).toBe('fallback');
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('returns null when every variant fails', async () => {
    const fetchFn = async () => {
      throw new Error('network');
    };
    expect(await searchOpenLibrary('Foo', null, { fetch: fetchFn })).toBeNull();
  });
});

describe('downloadOpenLibraryCover', () => {
  it('returns false for null doc without hitting the network', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return mockBytes(2000);
    };
    expect(await downloadOpenLibraryCover(null, '/tmp/x', { fetch: fetchFn })).toBe(false);
    expect(calls).toBe(0);
  });

  it('writes the cover and returns true when a real image is fetched', async () => {
    const fetchFn = async () => mockBytes(5000);
    let written = null;
    const writeFile = (p, b) => {
      written = { path: p, size: b.length };
    };
    const ok = await downloadOpenLibraryCover({ cover_i: 42 }, '/tmp/cover.jpg', {
      fetch: fetchFn,
      writeFile,
    });
    expect(ok).toBe(true);
    expect(written).toEqual({ path: '/tmp/cover.jpg', size: 5000 });
  });

  it(`filters out placeholder responses (< ${COVER_PLACEHOLDER_BYTES} bytes)`, async () => {
    const fetchFn = async () => mockBytes(COVER_PLACEHOLDER_BYTES - 1);
    let written = false;
    const writeFile = () => {
      written = true;
    };
    const ok = await downloadOpenLibraryCover({ cover_i: 42 }, '/tmp/cover.jpg', {
      fetch: fetchFn,
      writeFile,
    });
    expect(ok).toBe(false);
    expect(written).toBe(false);
  });

  it('falls through to the next URL on a non-ok response', async () => {
    let call = 0;
    const fetchFn = async () => {
      call++;
      if (call === 1) return { ok: false };
      return mockBytes(5000);
    };
    let written = false;
    const writeFile = () => {
      written = true;
    };
    const ok = await downloadOpenLibraryCover(
      { cover_i: 42, isbn: ['9780000000001'] },
      '/tmp/cover.jpg',
      { fetch: fetchFn, writeFile },
    );
    expect(ok).toBe(true);
    expect(call).toBe(2);
    expect(written).toBe(true);
  });
});

describe('fetchOpenLibraryDescription', () => {
  it('returns null for a doc without a key', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return mockOk({});
    };
    expect(await fetchOpenLibraryDescription({}, { fetch: fetchFn })).toBeNull();
    expect(calls).toBe(0);
  });

  it('returns the description when present', async () => {
    const fetchFn = async () => mockOk({ description: 'A novel.' });
    expect(await fetchOpenLibraryDescription({ key: '/works/OL1W' }, { fetch: fetchFn })).toBe(
      'A novel.',
    );
  });

  it('handles the typed-object description shape', async () => {
    const fetchFn = async () =>
      mockOk({
        description: { type: '/type/text', value: 'Typed.' },
      });
    expect(await fetchOpenLibraryDescription({ key: '/works/OL1W' }, { fetch: fetchFn })).toBe(
      'Typed.',
    );
  });

  it('returns null on a non-ok response', async () => {
    const fetchFn = async () => ({ ok: false });
    expect(
      await fetchOpenLibraryDescription({ key: '/works/OL1W' }, { fetch: fetchFn }),
    ).toBeNull();
  });

  it('returns null on a network error', async () => {
    const fetchFn = async () => {
      throw new Error('network');
    };
    expect(
      await fetchOpenLibraryDescription({ key: '/works/OL1W' }, { fetch: fetchFn }),
    ).toBeNull();
  });
});
