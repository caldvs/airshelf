const shelfEl = document.getElementById('shelf');
const serverUrlEl = document.getElementById('server-url');
const dropHint = document.getElementById('drop-hint');
const toastEl = document.getElementById('toast');


// ---- View switching ----
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(`view-${view}`).classList.remove('hidden');
  });
});

// ---- Toast ----
let toastTimer = null;
function showToast(msg, kind = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 4000);
}

// ---- Busy overlay ----
const busyEl = document.getElementById('busy');
function setBusy(msg) {
  if (msg) {
    busyEl.querySelector('.busy-msg').textContent = msg;
    busyEl.classList.add('active');
  } else {
    busyEl.classList.remove('active');
  }
}

// ---- Bookshelf ----
let selectedBookId = null;

// Reader writes `airshelf-reader-pct:<id>` whenever locations are ready and
// the user moves; absent value means the user has never opened the book.
function readReaderProgress(id) {
  const raw = localStorage.getItem(`airshelf-reader-pct:${id}`);
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function renderBooks(books, opts = {}) {
  shelfEl.innerHTML = '';

  if (selectedBookId && !books.find(b => b.id === selectedBookId)) {
    selectedBookId = null;
  }

  const intro = document.createElement('div');
  intro.className = 'shelf-intro';
  intro.innerHTML = '<h1>Your library</h1>';
  shelfEl.appendChild(intro);

  if (!books.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-empty';
    empty.textContent = opts.emptyMessage || 'No books yet. Click + or drop files here.';
    shelfEl.appendChild(empty);
    return;
  }

  for (const b of books) {
      // Card is a div (it contains block-level children which <button> can't
      // hold) but presents as a button to AT: role + tabindex + keyboard
      // activation handler. This was previously a plain <div> with click
      // handlers — unreachable without a mouse.
      const card = document.createElement('div');
      card.className = 'book-card';
      card.dataset.id = b.id;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', b.author ? `${b.title} by ${b.author}` : b.title);
      card.setAttribute('aria-pressed', b.id === selectedBookId ? 'true' : 'false');
      if (b.id === selectedBookId) card.classList.add('selected');

      const cover = document.createElement('div');
      cover.className = 'book-cover' + (b.coverUrl ? '' : ' placeholder');
      if (b.coverUrl) {
        const img = document.createElement('img');
        img.src = b.coverUrl;
        img.draggable = false;
        // Decorative — the card already has aria-label with the title.
        // Setting alt="" keeps screen readers from announcing the filename.
        img.alt = '';
        img.loading = 'lazy';
        img.width = 110;
        img.height = 156;
        cover.appendChild(img);
      } else {
        cover.textContent = b.title;
      }

      const pct = readReaderProgress(b.id);
      if (pct !== null) {
        const done = pct >= 100;
        if (done) cover.classList.add('finished');
        const bar = document.createElement('div');
        bar.className = 'cover-progress';
        bar.setAttribute('aria-hidden', 'true');
        const fill = document.createElement('div');
        fill.className = 'cover-progress-fill' + (done ? ' done' : '');
        fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        bar.appendChild(fill);
        cover.appendChild(bar);
        const label = document.createElement('div');
        label.className = 'cover-progress-label' + (done ? ' done' : '');
        label.textContent = done ? '✓ Done' : `${pct}%`;
        cover.appendChild(label);
      }

      const title = document.createElement('div');
      title.className = 'book-title';
      title.textContent = b.title;

      card.append(cover, title);

      if (b.author) {
        const author = document.createElement('div');
        author.className = 'book-author';
        author.textContent = b.year ? `${b.author} · ${b.year}` : b.author;
        card.append(author);
      } else if (b.year) {
        const yr = document.createElement('div');
        yr.className = 'book-author';
        yr.textContent = String(b.year);
        card.append(yr);
      }

      const size = document.createElement('div');
      size.className = 'book-size';
      const convertedLabel = b.converted ? ` · ${b.sourceExt.toUpperCase()}→AZW3` : '';
      size.textContent = `${b.sizeHuman}${convertedLabel}`;
      card.append(size);

      const select = () => {
        selectedBookId = b.id;
        document.querySelectorAll('.book-card').forEach(c => {
          const isSelected = c.dataset.id === b.id;
          c.classList.toggle('selected', isSelected);
          c.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        });
      };

      card.addEventListener('click', select);

      card.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (window.airshelfReader) window.airshelfReader.open(b);
      });

      // Keyboard activation: Enter selects, Space selects (matching click);
      // Enter when already selected opens the reader (mirrors dblclick).
      card.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (b.id === selectedBookId && window.airshelfReader) {
            window.airshelfReader.open(b);
          } else {
            select();
          }
        } else if (e.key === ' ') {
          e.preventDefault();
          select();
        }
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        select();
        window.airshelf.showContextMenu(b.id);
      });

      shelfEl.appendChild(card);
  }
}

// Click outside any card clears selection
document.addEventListener('click', (e) => {
  if (e.target.closest('.book-card')) return;
  if (e.target.closest('#btn-add')) return;
  if (selectedBookId !== null) {
    selectedBookId = null;
    document.querySelectorAll('.book-card.selected, .spine.selected').forEach(c => {
      c.classList.remove('selected');
      if (c.classList.contains('book-card')) {
        c.setAttribute('aria-pressed', 'false');
      }
    });
  }
});

// Delete key removes the selected book
document.addEventListener('keydown', async (e) => {
  if ((e.key === 'Backspace' || e.key === 'Delete') && selectedBookId) {
    const target = document.activeElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (document.getElementById('reader')?.classList.contains('active')) return;
    e.preventDefault();
    await window.airshelf.deleteBook(selectedBookId);
    selectedBookId = null;
    refresh();
  }
});

// Last result of books:list, kept so the search filter can re-render without
// a round-trip to main. Updated by refresh() and by books:changed events.
let allBooks = [];
let searchQuery = '';

function bookMatchesQuery(b, q) {
  // Plain substring matching is enough for the scale (hundreds of books, per
  // issue #42) and avoids needing tokenisation, fuzzy scoring, or an index.
  // Year is coerced to string so `2014` matches a numeric year field.
  return (b.title || '').toLowerCase().includes(q)
      || (b.author || '').toLowerCase().includes(q)
      || String(b.year || '').includes(q);
}

function applyBookView() {
  const q = searchQuery.trim().toLowerCase();
  const filtered = q ? allBooks.filter(b => bookMatchesQuery(b, q)) : allBooks;
  // Three empty cases: (a) library is empty, (b) library has books but the
  // active query excludes them all, (c) no query and library is empty. We
  // only override the default "No books yet…" copy in case (b), which is
  // the only one where a "No matches" message is actually accurate.
  const opts = q && filtered.length === 0 && allBooks.length > 0
    ? { emptyMessage: `No matches for “${searchQuery.trim()}”.` }
    : {};
  renderBooks(filtered, opts);
  updateSearchStatus(q, filtered.length);
}

async function refresh() {
  allBooks = await window.airshelf.listBooks();
  applyBookView();
}

function handleAddResult(result) {
  const { added = [], errors = [], duplicates = [] } = result || {};
  const parts = [];
  if (added.length) parts.push(`Added ${added.length}`);
  if (duplicates.length) parts.push(`${duplicates.length} already in library`);
  if (errors.length) parts.push(`${errors.length} failed`);

  let kind = 'success';
  if (!added.length && duplicates.length && !errors.length) kind = 'warn';
  else if (errors.length && !added.length) kind = 'error';
  else if (errors.length || (duplicates.length && !added.length)) kind = 'warn';

  if (!parts.length) return;

  if (added.length === 0 && duplicates.length === 1 && !errors.length) {
    showToast(`“${duplicates[0].title}” is already in your library`, 'warn');
  } else {
    showToast(parts.join(' · '), kind);
  }

  if (duplicates.length) console.warn('Duplicates:', duplicates);
  if (errors.length) console.warn('Failures:', errors);
}

document.getElementById('btn-add').addEventListener('click', () => triggerAdd());

async function triggerAdd() {
  const picked = await window.airshelf.pickBookPaths();
  if (!picked || !picked.paths || !picked.paths.length) return;
  setBusy(`Importing ${picked.paths.length} file${picked.paths.length === 1 ? '' : 's'}…`);
  try {
    const result = await window.airshelf.addBookPaths(picked.paths);
    handleAddResult(result);
  } finally {
    setBusy(null);
    refresh();
  }
}

// Drag and drop
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropHint.classList.add('active');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    dropHint.classList.remove('active');
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropHint.classList.remove('active');
  const paths = [];
  for (const f of e.dataTransfer.files) {
    const p = window.airshelf.getPathForFile(f);
    if (p) paths.push(p);
  }
  if (!paths.length) {
    showToast('Could not read dropped files', 'error');
    return;
  }
  setBusy(`Importing ${paths.length} file${paths.length === 1 ? '' : 's'}…`);
  try {
    const result = await window.airshelf.addBookPaths(paths);
    handleAddResult(result);
  } finally {
    setBusy(null);
    refresh();
  }
});

// ---- Transfer view ----
const pairUrlEl = document.getElementById('pair-url');
const pairBareUrlEl = document.getElementById('pair-bare-url');
const pairTtlEl = document.getElementById('pair-ttl');
const pairRotateBtn = document.getElementById('pair-rotate');
const serverUrlFallbackEl = document.getElementById('server-url-fallback');
const urlFallbackEl = document.getElementById('url-fallback');

async function loadServerInfo() {
  const info = await window.airshelf.serverInfo();
  if (info.mdnsUrl) {
    serverUrlEl.textContent = info.mdnsUrl;
    serverUrlFallbackEl.textContent = info.url;
    urlFallbackEl.classList.remove('hidden');
  } else {
    serverUrlEl.textContent = info.url;
    serverUrlFallbackEl.textContent = '';
    urlFallbackEl.classList.add('hidden');
  }
  // Bare URL the user can bookmark on their Kindle once paired — derived
  // from the IP host because the pairing cookie is host-only.
  if (pairBareUrlEl) pairBareUrlEl.textContent = `http://${info.ip}:${info.port}/`;
}

async function copyToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg, 'success');
  } catch (e) {
    showToast(`Copy failed: ${e.message}`, 'error');
  }
}

document.getElementById('btn-copy').addEventListener('click', () => {
  copyToClipboard(serverUrlEl.textContent, 'Copied');
});

// ---- Backup / restore ----
function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const btnBackup = document.getElementById('btn-backup');
if (btnBackup) {
  btnBackup.addEventListener('click', async () => {
    btnBackup.disabled = true;
    setBusy('Backing up…');
    try {
      const r = await window.airshelf.backupLibrary();
      if (r && r.canceled) return;
      if (r && r.ok) {
        showToast(`Backed up ${r.bookCount} book${r.bookCount === 1 ? '' : 's'} (${humanBytes(r.size)})`, 'success');
      } else {
        showToast(`Backup failed: ${(r && r.error) || 'unknown error'}`, 'error');
      }
    } finally {
      setBusy(null);
      btnBackup.disabled = false;
    }
  });
}

const btnRestore = document.getElementById('btn-restore');
if (btnRestore) {
  btnRestore.addEventListener('click', async () => {
    btnRestore.disabled = true;
    setBusy('Restoring…');
    try {
      const r = await window.airshelf.restoreLibrary();
      if (r && r.canceled) return;
      if (r && r.ok) {
        // Don't call refresh() here — main process emits books:changed
        // during restore and onBooksChanged below already refreshes.
        showToast(`Restored ${r.bookCount} book${r.bookCount === 1 ? '' : 's'}`, 'success');
      } else {
        showToast(`Restore failed: ${(r && r.error) || 'unknown error'}`, 'error');
      }
    } finally {
      setBusy(null);
      btnRestore.disabled = false;
    }
  });
}
// ---- Pair code (#34) ----
//
// We render the pair URL alongside the existing /<token>/ URL: the pair
// flow doesn't replace it (cookies are a per-device convenience), it
// just gives the user a shorter URL for first-time setup. The TTL ticks
// down once a second; when it hits zero we issue a fresh code so the
// user always has a usable code on screen.

let pairTtlTimer = null;
let pairCurrentExpiresAt = 0;

async function refreshPairCode({ forceRotate = false } = {}) {
  // If the Send view markup ever loses these ids (or in a future test
  // harness without the DOM), bail rather than null-deref'ing.
  if (!pairUrlEl || !pairTtlEl) return;
  let info;
  try {
    info = forceRotate
      ? await window.airshelf.pairRotate()
      : await window.airshelf.pairCurrent();
  } catch (e) {
    if (pairTtlTimer) clearInterval(pairTtlTimer);
    pairTtlTimer = null;
    pairCurrentExpiresAt = 0;
    pairUrlEl.textContent = 'pair unavailable';
    pairTtlEl.textContent = '';
    showToast(`Pair code failed: ${e.message}`, 'error');
    return;
  }
  pairUrlEl.textContent = info.pairUrl;
  pairCurrentExpiresAt = info.expiresAt;
  startPairTtlTimer();
}

function startPairTtlTimer() {
  if (pairTtlTimer) clearInterval(pairTtlTimer);
  const tick = () => {
    const remaining = Math.max(0, Math.floor((pairCurrentExpiresAt - Date.now()) / 1000));
    pairTtlEl.textContent = remaining > 0 ? `${remaining}s` : 'expired';
    // When the code expires the renderer asks main for a fresh one. The
    // server already sweeps expired entries, so this just resyncs UI with
    // the next-issued code.
    if (remaining === 0) {
      clearInterval(pairTtlTimer);
      pairTtlTimer = null;
      refreshPairCode();
    }
  };
  tick();
  pairTtlTimer = setInterval(tick, 1000);
}

if (pairRotateBtn) {
  pairRotateBtn.addEventListener('click', () => refreshPairCode({ forceRotate: true }));
}
if (pairUrlEl) {
  pairUrlEl.addEventListener('click', () => {
    copyToClipboard(pairUrlEl.textContent, 'Pair URL copied');
  });
}

// ---- Calibre import ----
const btnCalibreImport = document.getElementById('btn-calibre-import');
if (btnCalibreImport && window.airshelf.importFromCalibre) {
  // Stream per-book progress into the busy overlay so a multi-hundred
  // book library doesn't look frozen. Main throttles via the natural
  // pace of addBook (file copy + Calibre conversion), so no extra
  // debouncing needed on this end.
  if (window.airshelf.onImportProgress) {
    window.airshelf.onImportProgress(({ done, total }) => {
      setBusy(`Importing from Calibre — ${done}/${total}`);
    });
  }
  btnCalibreImport.addEventListener('click', async () => {
    btnCalibreImport.disabled = true;
    setBusy('Reading Calibre library…');
    try {
      const r = await window.airshelf.importFromCalibre();
      if (r && r.canceled) return;
      if (r && r.error) {
        showToast(r.error, 'error');
        return;
      }
      const added = (r.added || []).length;
      const dupes = (r.duplicates || []).length;
      const errs = (r.errors || []).length;
      const parts = [`Imported ${added} of ${r.total}`];
      if (dupes) parts.push(`${dupes} already in library`);
      if (errs) parts.push(`${errs} failed`);
      showToast(parts.join(' · '), errs ? 'warn' : 'success');
    } finally {
      setBusy(null);
      btnCalibreImport.disabled = false;
    }
  });
}

// Listen for background migrations / changes from main
if (window.airshelf.onBooksChanged) {
  window.airshelf.onBooksChanged(() => {
    refresh();
  });
}

// ---- Cover URL modal ----
const urlModal = document.getElementById('url-modal');
const urlInput = document.getElementById('url-input');
const urlOk = document.getElementById('url-ok');
const urlCancel = document.getElementById('url-cancel');
let urlTargetId = null;

function openUrlModal(bookId) {
  urlTargetId = bookId;
  urlInput.value = '';
  urlModal.classList.add('active');
  setTimeout(() => urlInput.focus(), 0);
}
function closeUrlModal() {
  urlModal.classList.remove('active');
  urlTargetId = null;
}
async function submitUrlModal() {
  const url = urlInput.value.trim();
  if (!url || !urlTargetId) { closeUrlModal(); return; }
  const id = urlTargetId;
  closeUrlModal();
  setBusy('Fetching cover…');
  try {
    const r = await window.airshelf.setCoverFromUrl(id, url);
    if (r && r.error) showToast(r.error, 'error');
    else showToast('Cover updated', 'success');
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  } finally {
    setBusy(null);
    refresh();
  }
}
urlOk.addEventListener('click', submitUrlModal);
urlCancel.addEventListener('click', closeUrlModal);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitUrlModal();
  else if (e.key === 'Escape') closeUrlModal();
});
urlModal.addEventListener('click', (e) => {
  if (e.target === urlModal) closeUrlModal();
});
if (window.airshelf.onCoverPromptUrl) {
  window.airshelf.onCoverPromptUrl((id) => openUrlModal(id));
}

// ---- Theme picker ----
const savedTheme = localStorage.getItem('airshelf-theme') || 'cloud';
document.documentElement.setAttribute('data-theme', savedTheme);
document.querySelectorAll('.theme-swatch').forEach(sw => {
  if (sw.dataset.theme === savedTheme) sw.classList.add('active');
  else sw.classList.remove('active');
  sw.addEventListener('click', () => {
    const theme = sw.dataset.theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('airshelf-theme', theme);
    document.querySelectorAll('.theme-swatch').forEach(s => s.classList.toggle('active', s.dataset.theme === theme));
  });
});

// ---- Search palette ----
//
// Toggled by ⌘K / Ctrl+K. Live-filters the shelf as the user types. Filter
// state survives palette close so a result-narrowed shelf stays narrowed
// until the user clears the query — closing is just dismissing the palette,
// not the search. ESC is two-step: the first press clears the query, the
// second dismisses the palette.

const searchPalette = document.getElementById('search-palette');
const searchInput = document.getElementById('search-input');
const searchStatus = document.getElementById('search-palette-status');

function updateSearchStatus(q, n) {
  if (!q) { searchStatus.textContent = ''; return; }
  const total = allBooks.length;
  searchStatus.textContent = n === total
    ? `${n} match${n === 1 ? '' : 'es'}`
    : `${n} of ${total}`;
}

function openSearchPalette() {
  searchPalette.classList.add('active');
  searchInput.value = searchQuery;
  // Defer focus until after the paint that adds .active so the keyboard
  // doesn't appear and immediately get blurred by the layout shift. The
  // .active check inside guards against the user hitting ⌘K twice quickly:
  // close-then-RAF would otherwise put focus into a hidden input.
  requestAnimationFrame(() => {
    if (!searchPalette.classList.contains('active')) return;
    searchInput.focus();
    searchInput.select();
  });
}

function closeSearchPalette() {
  searchPalette.classList.remove('active');
}

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  applyBookView();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (searchInput.value) {
      // First Escape clears, second closes — common palette behaviour.
      searchInput.value = '';
      searchQuery = '';
      applyBookView();
    } else {
      closeSearchPalette();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    closeSearchPalette();
  }
});

searchPalette.addEventListener('click', (e) => {
  // Click on the backdrop (outside the box) closes; clicks inside don't.
  if (e.target === searchPalette) closeSearchPalette();
});

// Per-platform shortcut: ⌘K on macOS, Ctrl+K elsewhere. Accepting either
// modifier on Mac would clobber Ctrl+K's "delete to end of line" binding
// in text inputs.
const IS_MAC = /Mac|iPad|iPhone|iPod/.test(navigator.platform || '');

document.addEventListener('keydown', (e) => {
  // Always-global on purpose — even if another input has focus (e.g. the
  // cover-URL modal), the palette shortcut should still surface the
  // palette. Browsers don't bind ⌘K in text inputs on macOS, so there's
  // nothing useful to preserve.
  //
  // Exception: while the reader overlay is active, the shortcut is a
  // no-op. The reader has its own Escape handler and we don't want the
  // palette opening over the book and stealing subsequent Escape presses.
  if (e.key !== 'k' && e.key !== 'K') return;
  const modifierMatch = IS_MAC
    ? (e.metaKey && !e.ctrlKey)
    : (e.ctrlKey && !e.metaKey);
  if (!modifierMatch) return;
  if (document.getElementById('reader')?.classList.contains('active')) return;
  e.preventDefault();
  if (searchPalette.classList.contains('active')) closeSearchPalette();
  else openSearchPalette();
});
// ---- Calibre detection ----
//
// The banner above the shelf is dismissable via localStorage so users who
// genuinely don't need Calibre (Kindle-native formats only) aren't nagged on
// every launch. Any transition to "found" — auto or user — clears the dismiss
// flag, so future breakage re-surfaces the banner. The Settings panel always
// reflects current status regardless.

const CALIBRE_DOWNLOAD_URL = 'https://calibre-ebook.com/download_osx';
const CALIBRE_BANNER_DISMISS_KEY = 'airshelf-calibre-banner-dismissed';

const calibreBanner = document.getElementById('calibre-banner');
const calibreStatusEl = document.getElementById('calibre-status');
const calibreStatusPathEl = document.getElementById('calibre-status-path');
const calibreClearBtn = document.getElementById('calibre-clear');

async function refreshCalibreStatus() {
  let s;
  try {
    s = await window.airshelf.calibreStatus();
  } catch {
    s = { found: false, binDir: null, source: null };
  }
  // Forget-button visibility is tied to whether a user path is *saved* in
  // settings, not to whether it's currently active. A saved-but-stale entry
  // (Calibre moved/uninstalled, auto-detect took over) still needs to be
  // clearable from the UI, otherwise the dead path stays in settings.json
  // forever.
  calibreClearBtn.classList.toggle('hidden', !s.userPathSaved);

  if (s.found) {
    calibreStatusEl.textContent = s.source === 'user' ? 'Found (custom path)' : 'Found';
    calibreStatusPathEl.textContent = s.binDir || '';
    calibreBanner.classList.add('hidden');
    // Clear the dismiss flag on every found-state read, not just after a
    // successful Locate, so an auto-detected Calibre arrival also resets it.
    localStorage.removeItem(CALIBRE_BANNER_DISMISS_KEY);
  } else {
    calibreStatusEl.textContent = 'Not found';
    calibreStatusPathEl.textContent = '';
    if (!localStorage.getItem(CALIBRE_BANNER_DISMISS_KEY)) {
      calibreBanner.classList.remove('hidden');
    }
  }
  return s;
}

async function calibreLocateFlow() {
  let r;
  try {
    r = await window.airshelf.calibreLocate();
  } catch (e) {
    showToast(`Locate failed: ${e.message}`, 'error');
    return;
  }
  if (!r || r.canceled) return;
  if (r.error) { showToast(r.error, 'error'); return; }
  showToast('Calibre saved', 'success');
  refreshCalibreStatus();
}

async function openCalibreDownload() {
  try {
    // open:external resolves with `{ ok, error }` rather than rejecting on
    // shell-open failure, so we need to inspect the payload too.
    const r = await window.airshelf.openExternal(CALIBRE_DOWNLOAD_URL);
    if (r && r.ok === false) {
      showToast(`Could not open browser: ${r.error || 'unknown error'}`, 'error');
    }
  } catch (e) {
    showToast(`Could not open browser: ${e.message}`, 'error');
  }
}

document.getElementById('calibre-banner-locate').addEventListener('click', calibreLocateFlow);
document.getElementById('calibre-banner-get').addEventListener('click', openCalibreDownload);
document.getElementById('calibre-banner-dismiss').addEventListener('click', () => {
  localStorage.setItem(CALIBRE_BANNER_DISMISS_KEY, '1');
  calibreBanner.classList.add('hidden');
});
document.getElementById('calibre-redetect').addEventListener('click', refreshCalibreStatus);
document.getElementById('calibre-locate').addEventListener('click', calibreLocateFlow);
document.getElementById('calibre-clear').addEventListener('click', async () => {
  try {
    await window.airshelf.calibreClear();
  } catch (e) {
    showToast(`Forget failed: ${e.message}`, 'error');
    return;
  }
  refreshCalibreStatus();
});
document.getElementById('calibre-get').addEventListener('click', openCalibreDownload);

// ---- Init ----
refresh();
loadServerInfo();
setInterval(loadServerInfo, 5000);
refreshPairCode();
refreshCalibreStatus();
