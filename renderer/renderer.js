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

function renderBooks(books) {
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
    empty.textContent = 'No books yet. Click + or drop files here.';
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
  renderBooks(filtered);
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
async function loadServerInfo() {
  const info = await window.airshelf.serverInfo();
  serverUrlEl.textContent = info.url;
}

document.getElementById('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(serverUrlEl.textContent);
  showToast('Copied', 'success');
});

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
  // doesn't appear and immediately get blurred by the layout shift.
  requestAnimationFrame(() => {
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

document.addEventListener('keydown', (e) => {
  // ⌘K (mac) or Ctrl+K (windows/linux). Always-global on purpose — even if
  // another input has focus (e.g. the cover-URL modal), ⌘K should still
  // surface the palette. Browsers don't bind anything to ⌘K in text inputs
  // so there's nothing useful to preserve.
  const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
  if (!isCmdK) return;
  e.preventDefault();
  if (searchPalette.classList.contains('active')) closeSearchPalette();
  else openSearchPalette();
});

// ---- Init ----
refresh();
loadServerInfo();
setInterval(loadServerInfo, 5000);
