// Popup logic — pairs once, then sends the active tab's URL on click.
//
// "Pair" stores the user's full Airshelf Kindle URL (e.g.
// http://127.0.0.1:6790/abcdef/). The extension parses it into base +
// token at storage time so subsequent sends don't need to re-validate.
// Token is kept in `chrome.storage.local` (synced devices don't share
// the loopback URL anyway).

const $ = (sel) => document.querySelector(sel);

const setupSection = $('#setup-section');
const sendSection = $('#send-section');
const kindleUrlInput = $('#kindle-url');
const saveTokenBtn = $('#save-token-btn');
const setupStatus = $('#setup-status');
const sendStatus = $('#send-status');
const sendBtn = $('#send-btn');
const unpairBtn = $('#unpair-btn');
const pageTitleEl = $('#page-title');
const pairedHostEl = $('#paired-host');

// Allow http://127.0.0.1:PORT/<token>/ (with or without trailing slash). The
// loopback IP and the lowercase 6-char token are both required by the
// Airshelf server, so duplicating the check here surfaces a clear error
// before we try to send. localhost is also allowed since some browsers
// resolve it differently than 127.0.0.1.
const URL_RE = /^(https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)\/([a-z]{6})\/?$/;

function parseKindleUrl(input) {
  const m = (input || '').trim().match(URL_RE);
  if (!m) return null;
  return { base: m[1], token: m[2] };
}

async function getPaired() {
  const out = await chrome.storage.local.get(['base', 'token']);
  return out.base && out.token ? out : null;
}

async function setPaired({ base, token }) {
  await chrome.storage.local.set({ base, token });
}

async function clearPaired() {
  await chrome.storage.local.remove(['base', 'token']);
}

function setStatus(el, msg, kind = 'info') {
  el.textContent = msg;
  el.classList.remove('hidden', 'error', 'success');
  if (kind !== 'info') el.classList.add(kind);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Strip query/hash, take the path basename, decode it, and pin the
// extension to .pdf if the URL had no extension. Airshelf rejects
// uploads via X-Filename whose extension isn't in its allowlist, so the
// extension is what determines whether the upload succeeds.
function deriveFilename(url, fallback = 'page.pdf') {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const decoded = (() => {
      try { return decodeURIComponent(last); } catch { return last; }
    })();
    if (!decoded) return fallback;
    if (/\.[a-z0-9]{2,5}$/i.test(decoded)) return decoded;
    return decoded + '.pdf';
  } catch {
    return fallback;
  }
}

async function send() {
  const paired = await getPaired();
  if (!paired) {
    setStatus(sendStatus, 'Not paired.', 'error');
    return;
  }
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    setStatus(sendStatus, 'No active tab.', 'error');
    return;
  }

  sendBtn.disabled = true;
  setStatus(sendStatus, 'Fetching page bytes…');

  let blob;
  try {
    const resp = await fetch(tab.url);
    if (!resp.ok) {
      setStatus(sendStatus, `Fetch failed: ${resp.status}`, 'error');
      sendBtn.disabled = false;
      return;
    }
    blob = await resp.blob();
  } catch (e) {
    setStatus(sendStatus, `Fetch failed: ${e.message}`, 'error');
    sendBtn.disabled = false;
    return;
  }

  const filename = deriveFilename(tab.url);
  setStatus(sendStatus, `Uploading ${filename} (${(blob.size / 1024).toFixed(0)} KB)…`);

  try {
    const resp = await fetch(`${paired.base}/${paired.token}/upload`, {
      method: 'POST',
      headers: { 'X-Filename': filename, 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!resp.ok) {
      const txt = await resp.text();
      setStatus(sendStatus, `Server: ${resp.status} ${txt}`.slice(0, 240), 'error');
    } else {
      setStatus(sendStatus, `Sent ${filename}.`, 'success');
    }
  } catch (e) {
    setStatus(sendStatus, `Upload failed: ${e.message}`, 'error');
  }
  sendBtn.disabled = false;
}

async function refreshUI() {
  const paired = await getPaired();
  if (paired) {
    setupSection.classList.add('hidden');
    sendSection.classList.remove('hidden');
    pairedHostEl.textContent = paired.base;
    const tab = await getActiveTab();
    pageTitleEl.textContent = (tab && (tab.title || tab.url)) || '';
  } else {
    setupSection.classList.remove('hidden');
    sendSection.classList.add('hidden');
  }
}

saveTokenBtn.addEventListener('click', async () => {
  const parsed = parseKindleUrl(kindleUrlInput.value);
  if (!parsed) {
    setStatus(setupStatus, 'Expected http://127.0.0.1:6790/<6-char token>/.', 'error');
    return;
  }
  await setPaired(parsed);
  setStatus(setupStatus, 'Paired.', 'success');
  await refreshUI();
});

unpairBtn.addEventListener('click', async () => {
  await clearPaired();
  await refreshUI();
});

sendBtn.addEventListener('click', send);

refreshUI();
