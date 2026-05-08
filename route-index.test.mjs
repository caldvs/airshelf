import { describe, it, expect } from 'vitest';
import { renderShelfHtml } from './route-index.js';

const TOKEN = 'deadbeef0123';
const BOOK = {
  id: 'abc123',
  title: 'A Test Book',
  author: 'Jane Doe',
  year: 2024,
  cover: 'abc123.cover',
  size: 1234567,
};

function render(books) {
  return renderShelfHtml({ books, serverToken: TOKEN });
}

describe('renderShelfHtml', () => {
  it('renders the empty-library message when no books are present', () => {
    const html = render([]);
    expect(html).toMatch(/No books yet/);
    // Empty libraries shouldn't show a count line.
    expect(html).not.toMatch(/books available/);
  });

  it('renders a single-book "1 book available" count', () => {
    const html = render([BOOK]);
    expect(html).toMatch(/1 book available/);
    expect(html).not.toMatch(/1 books available/);
  });

  it('uses the plural for 2+ books', () => {
    const html = render([BOOK, { ...BOOK, id: 'b2', title: 'Two' }]);
    expect(html).toMatch(/2 books available/);
  });

  it('renders the per-row "N of total" index', () => {
    const html = render([BOOK, { ...BOOK, id: 'b2', title: 'Two' }]);
    expect(html).toMatch(/1 of 2/);
    expect(html).toMatch(/2 of 2/);
  });

  it('embeds the server token in download + cover URLs', () => {
    const html = render([BOOK]);
    expect(html).toMatch(new RegExp(`/${TOKEN}/cover/${BOOK.id}`));
    expect(html).toMatch(new RegExp(`/${TOKEN}/download/${BOOK.id}`));
  });

  it('escapes HTML in book titles to prevent XSS', () => {
    const html = render([{ ...BOOK, title: '<script>alert(1)</script>' }]);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('escapes HTML in book authors', () => {
    const html = render([{ ...BOOK, author: 'a"b\'c<d>e&f' }]);
    expect(html).not.toMatch(/a"b'c<d>/);
    expect(html).toMatch(/a&quot;b&#39;c&lt;d&gt;e&amp;f/);
  });

  it('escapes title fragment in the cover-fallback when no cover is set', () => {
    const html = render([{ ...BOOK, cover: null, title: '<img src=x>' }]);
    // Cover fallback uses a slice of the title — must still be escaped.
    expect(html).toMatch(/<div class="cover-frame cover-fallback"/);
    expect(html).not.toMatch(/<img src=x>/);
    expect(html).toMatch(/&lt;img src=x&gt;/);
  });

  it('omits the author line when book.author is missing and no year', () => {
    const html = render([{ ...BOOK, author: undefined, year: undefined }]);
    expect(html).not.toMatch(/<div class="author">/);
  });

  it('falls back to the year alone when author is missing but year is set', () => {
    const html = render([{ ...BOOK, author: undefined, year: 1999 }]);
    expect(html).toMatch(/<div class="author">1999<\/div>/);
  });

  it('renders author + year together when both are set', () => {
    const html = render([{ ...BOOK, author: 'Asimov', year: 1951 }]);
    expect(html).toMatch(/Asimov.*1951/);
  });

  it('uses a cover-frame with background-image when book.cover is set', () => {
    const html = render([BOOK]);
    expect(html).toMatch(/cover-frame.*background-image:url\('\/[^']+\/cover\/abc123'\)/);
    // Negative match has to be specific — `.cover-fallback` is also a class
    // selector in the embedded <style>, so a bare /cover-fallback/ regex
    // would hit the stylesheet rather than the rendered cover.
    expect(html).not.toMatch(/<div class="cover-frame cover-fallback"/);
  });

  it('uses cover-fallback rendering when book.cover is not set', () => {
    const html = render([{ ...BOOK, cover: null }]);
    expect(html).toMatch(/<div class="cover-frame cover-fallback"/);
  });

  it('renders the size in human units', () => {
    const html = render([{ ...BOOK, size: 2 * 1024 * 1024 }]);
    expect(html).toMatch(/AZW3.*2\.0 MB/);
  });
});
