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

function groupBooks(books) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Week starts Monday
  const dayIdx = (now.getDay() + 6) % 7;
  const startOfWeek = startOfToday - dayIdx * 86400000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();

  const groups = new Map();
  const order = [];
  function bucket(label) {
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    return groups.get(label);
  }

  for (const b of books) {
    const t = b.addedAt || 0;
    if (t >= startOfToday) bucket('Today').push(b);
    else if (t >= startOfWeek) bucket('Earlier this week').push(b);
    else if (t >= startOfMonth) bucket('Earlier this month').push(b);
    else if (t >= startOfYear) bucket('Earlier this year').push(b);
    else {
      const year = new Date(t).getFullYear();
      bucket(String(year || 'Older')).push(b);
    }
  }
  return order.map(label => ({ label, books: groups.get(label) }));
}

function renderBooks(books) {
  shelfEl.innerHTML = '';

  // Reset selection if the selected book no longer exists
  if (selectedBookId && !books.find(b => b.id === selectedBookId)) {
    selectedBookId = null;
  }

  const groups = groupBooks(books);
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-empty';
    empty.textContent = 'No books yet. Click + or drop files here.';
    shelfEl.appendChild(empty);
    return;
  }

  groups.forEach((group) => {
    const section = document.createElement('section');
    section.className = 'shelf-section';

    const header = document.createElement('h2');
    header.className = 'shelf-section-title';
    header.textContent = group.label;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'shelf-grid';

    for (const b of group.books) {
      const card = document.createElement('div');
      card.className = 'book-card';
      card.dataset.id = b.id;
      if (b.id === selectedBookId) card.classList.add('selected');

      const cover = document.createElement('div');
      cover.className = 'book-cover' + (b.coverUrl ? '' : ' placeholder');
      if (b.coverUrl) {
        const img = document.createElement('img');
        img.src = b.coverUrl;
        img.draggable = false;
        cover.appendChild(img);
      } else {
        cover.textContent = b.title;
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
        const year = document.createElement('div');
        year.className = 'book-author';
        year.textContent = String(b.year);
        card.append(year);
      }

      const size = document.createElement('div');
      size.className = 'book-size';
      const convertedLabel = b.converted ? ` · ${b.sourceExt.toUpperCase()}→MOBI` : '';
      size.textContent = `${b.sizeHuman}${convertedLabel}`;
      card.append(size);

      card.addEventListener('click', () => {
        selectedBookId = b.id;
        document.querySelectorAll('.book-card').forEach(c => c.classList.toggle('selected', c.dataset.id === b.id));
      });

      card.addEventListener('dblclick', (e) => {
        e.preventDefault();
        window.airshelf.showContextMenu(b.id);
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selectedBookId = b.id;
        document.querySelectorAll('.book-card').forEach(c => c.classList.toggle('selected', c.dataset.id === b.id));
        window.airshelf.showContextMenu(b.id);
      });

      grid.appendChild(card);
    }

    section.appendChild(grid);
    shelfEl.appendChild(section);
  });
}

// Click outside any card clears selection
document.addEventListener('click', (e) => {
  if (e.target.closest('.book-card')) return;
  if (e.target.closest('#btn-add')) return;
  if (selectedBookId !== null) {
    selectedBookId = null;
    document.querySelectorAll('.book-card.selected').forEach(c => c.classList.remove('selected'));
  }
});

// Delete key removes the selected book
document.addEventListener('keydown', async (e) => {
  if ((e.key === 'Backspace' || e.key === 'Delete') && selectedBookId) {
    const target = document.activeElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    await window.airshelf.deleteBook(selectedBookId);
    selectedBookId = null;
    refresh();
  }
});

async function refresh() {
  const books = await window.airshelf.listBooks();
  renderBooks(books);
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
    showToast('Library updated', 'success');
  });
}

// ---- Init ----
refresh();
loadServerInfo();
setInterval(loadServerInfo, 5000);
