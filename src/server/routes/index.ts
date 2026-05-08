// Renders the HTML bookshelf served at `/<token>/` and `/<token>/index.html`,
// the entry point the Kindle's experimental browser hits. All inputs come in
// as args so the function is pure — easy to test without booting Electron or
// the http server, and impossible to forget escaping.
//
// HTML escaping covers all title/author strings on the way into the DOM. The
// download/cover URLs contain only the server token (a 6-letter lowercase
// pronounceable string per auth.js TOKEN_RE) and the book id (hex per
// addBook), so they don't need escaping.

// These helpers duplicate the pair in src/lib/utils.ts. Kept local so this
// route module has no external imports beyond Node stdlib (it has none).
function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string,
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ShelfBook {
  id: string;
  title: string;
  author?: string | null;
  year?: number | null;
  cover?: string | null;
  size: number;
}

function renderRow(b: ShelfBook, i: number, total: number, serverToken: string): string {
  const authorLine = b.author
    ? `<div class="author">${escapeHtml(b.author)}${b.year ? ` &middot; ${b.year}` : ''}</div>`
    : b.year
      ? `<div class="author">${b.year}</div>`
      : '';
  const cover = b.cover
    ? `<div class="cover-frame" style="background-image:url('/${serverToken}/cover/${b.id}')"></div>`
    : `<div class="cover-frame cover-fallback">${escapeHtml(b.title.slice(0, 40))}</div>`;
  return `
    <table class="book" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td colspan="3" class="index-cell">${i + 1} of ${total}</td>
      </tr>
      <tr>
        <td class="cover-cell" valign="middle" width="190">
          ${cover}
        </td>
        <td class="info-cell" valign="middle">
          <div class="title">${escapeHtml(b.title)}</div>
          ${authorLine}
          <div class="meta">AZW3 &middot; ${humanSize(b.size)}</div>
        </td>
        <td class="btn-cell" valign="middle" align="right">
          <a class="dl-btn" href="/${serverToken}/download/${b.id}">Download</a>
        </td>
      </tr>
      <tr><td colspan="3" class="spacer"></td></tr>
    </table>
  `;
}

const STYLE = `
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    -webkit-text-size-adjust: none;
  }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 20px;
    line-height: 1.35;
    padding: 24px 20px 40px 20px;
  }

  /* Header */
  h1 { font-size: 42px; margin: 0 0 6px 0; font-weight: bold; }
  .sub { font-size: 20px; margin: 0 0 8px 0; }
  .count { font-size: 18px; margin: 0 0 16px 0; color: #333; }
  .head-rule { border: 0; border-top: 2px solid #000; margin: 0 0 12px 0; height: 0; }

  /* Book rows */
  table.book { margin: 0; width: 100%; }
  td.index-cell {
    padding: 22px 0 6px 0;
    font-size: 18px;
    font-weight: bold;
    color: #666;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  td.cover-cell { width: 190px; padding: 8px 24px 28px 0; vertical-align: middle; }
  td.info-cell  { padding: 8px 16px 28px 0; vertical-align: middle; }
  td.btn-cell   { padding: 8px 0 28px 0; vertical-align: middle; text-align: right; white-space: nowrap; }
  td.spacer {
    border-top: 1px solid #ccc;
    height: 0;
    line-height: 0;
    font-size: 0;
    padding: 0;
  }

  /* Cover: fixed 180x252 frame (20% larger), image fills entire area */
  .cover-frame {
    display: block;
    width: 180px;
    height: 252px;
    background-color: #fff;
    background-position: center center;
    background-repeat: no-repeat;
    background-size: cover;
    overflow: hidden;
  }
  .cover-fallback {
    line-height: 1.3;
    padding: 14px;
    box-sizing: border-box;
    text-align: center;
    font-weight: bold;
    font-size: 16px;
    background-color: #f0f0f0;
    background-image: none;
  }

  /* Title, author, meta */
  .title  { font-size: 30px; font-weight: bold; line-height: 1.2; margin: 0 0 8px 0; color: #000; }
  .author { font-size: 22px; line-height: 1.3; margin: 0 0 10px 0; color: #333; font-style: italic; }
  .meta   { font-size: 20px; color: #333; margin: 0; }

  /* Download button — 2x size, right-aligned next to info */
  a.dl-btn {
    display: inline-block;
    padding: 28px 44px;
    border: 2px solid #000;
    background: #000;
    color: #fff;
    text-decoration: none;
    font-weight: bold;
    font-size: 24px;
    text-align: center;
    white-space: nowrap;
  }

  .empty {
    text-align: center;
    padding: 60px 20px;
    font-size: 22px;
    border-top: 2px solid #000;
    border-bottom: 2px solid #000;
  }
  .footer { margin-top: 28px; font-size: 16px; color: #555; text-align: center; }
`;

interface RenderShelfArgs {
  books: ShelfBook[];
  serverToken: string;
}

// The Kindle-facing landing page.
export function renderShelfHtml({ books, serverToken }: RenderShelfArgs): string {
  const total = books.length;
  const rows = books.map((b, i) => renderRow(b, i, total, serverToken)).join('');
  const count = total;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>Airshelf</title>
<style>${STYLE}</style>
</head>
<body>
  <h1>Airshelf</h1>
  <div class="sub">Tap a book to download.</div>
  ${count ? `<div class="count">${count} ${count === 1 ? 'book' : 'books'} available</div>` : ''}
  <hr class="head-rule">
  ${count ? rows : `<div class="empty">No books yet.<br>Add some in the Airshelf app on your Mac.</div>`}
  <div class="footer">Airshelf</div>
</body>
</html>`;
}
