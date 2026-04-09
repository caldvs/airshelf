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
function renderBooks(books) {
  shelfEl.innerHTML = '';
  if (!books.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-empty';
    empty.textContent = 'No books yet. Click + or drop files here.';
    shelfEl.appendChild(empty);
    return;
  }
  for (const b of books) {
    const card = document.createElement('div');
    card.className = 'book-card';

    const cover = document.createElement('div');
    cover.className = 'book-cover' + (b.coverUrl ? '' : ' placeholder');
    if (b.coverUrl) {
      const img = document.createElement('img');
      img.src = b.coverUrl;
      cover.appendChild(img);
    } else {
      cover.textContent = b.title;
    }

    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = b.title;

    const size = document.createElement('div');
    size.className = 'book-size';
    const convertedLabel = b.converted ? ` · ${b.sourceExt.toUpperCase()}→MOBI` : '';
    size.textContent = `${b.sizeHuman}${convertedLabel}`;

    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.textContent = '×';
    del.title = 'Delete';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.airshelf.deleteBook(b.id);
      refresh();
    });

    card.append(cover, title, size, del);
    shelfEl.appendChild(card);
  }
}

async function refresh() {
  const books = await window.airshelf.listBooks();
  renderBooks(books);
}

function handleAddResult(result, total) {
  const { added, errors } = result || { added: [], errors: [] };
  if (added.length && !errors.length) {
    showToast(`Added ${added.length} book${added.length === 1 ? '' : 's'}`, 'success');
  } else if (added.length && errors.length) {
    showToast(`Added ${added.length}, failed ${errors.length}`, 'warn');
    console.warn('Failures:', errors);
  } else if (errors.length) {
    showToast(`Failed: ${errors[0].error}`, 'error');
    console.warn('Failures:', errors);
  }
}

document.getElementById('btn-add').addEventListener('click', async () => {
  setBusy('Importing & converting…');
  try {
    const result = await window.airshelf.addBooks();
    handleAddResult(result);
  } finally {
    setBusy(null);
    refresh();
  }
});

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
