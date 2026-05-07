// Reader view powered by epub.js. Loads the original .epub from the local
// HTTP server so epubjs sees it as a regular zip resource. State (font size,
// last reading location) persists in localStorage keyed by book id.
(function () {
  const readerEl = document.getElementById('reader');
  const viewportEl = document.getElementById('reader-viewport');
  const titleEl = document.getElementById('reader-title');
  const authorEl = document.getElementById('reader-author');
  const closeBtn = document.getElementById('reader-close');
  const fontUpBtn = document.getElementById('reader-font-up');
  const fontDownBtn = document.getElementById('reader-font-down');
  const themeBtn = document.getElementById('reader-theme-btn');
  const tocBtn = document.getElementById('reader-toc-btn');
  const tocEl = document.getElementById('reader-toc');
  const tocList = document.getElementById('reader-toc-list');
  const prevZone = document.getElementById('reader-prev');
  const nextZone = document.getElementById('reader-next');
  const progressEl = document.getElementById('reader-progress');
  const posEl = document.getElementById('reader-pos');

  let book = null;
  let rendition = null;
  let currentBookId = null;
  let currentLocation = null;
  let locationsReady = false;
  let resizeTimer = null;

  const FONT_KEY = 'airshelf-reader-font';
  const THEME_KEY = 'airshelf-reader-theme';
  const LOC_KEY = (id) => `airshelf-reader-loc:${id}`;
  const FONT_MIN = 80;
  const FONT_MAX = 180;
  const FONT_STEP = 10;

  const READER_THEMES = {
    light: { body: { background: '#ffffff', color: '#1a1d23' } },
    dark: { body: { background: '#1a1d23', color: '#e4e6ea' } },
  };

  // Resolve initial theme: explicit override > app theme (slate=dark) > prefers-color-scheme.
  // Note: the renderer always sets a `data-theme` attribute, so we check the user's
  // explicit app-theme choice in localStorage rather than the attribute presence.
  function resolveDefaultTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    const appTheme = document.documentElement.getAttribute('data-theme');
    if (appTheme === 'slate') return 'dark';
    const userPickedAppTheme = localStorage.getItem('airshelf-theme') !== null;
    if (!userPickedAppTheme && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }

  function applyReaderTheme(name) {
    document.body.classList.toggle('reader-dark', name === 'dark');
    document.body.classList.toggle('reader-light', name === 'light');
    if (themeBtn) themeBtn.setAttribute('aria-pressed', String(name === 'dark'));
    if (rendition) {
      try { rendition.themes.select(name); } catch (_) {}
    }
  }

  function setReaderTheme(name) {
    localStorage.setItem(THEME_KEY, name);
    applyReaderTheme(name);
  }

  function getFontPct() {
    const v = parseInt(localStorage.getItem(FONT_KEY) || '110', 10);
    return Number.isFinite(v) ? Math.max(FONT_MIN, Math.min(FONT_MAX, v)) : 110;
  }
  function setFontPct(pct) {
    const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, pct));
    localStorage.setItem(FONT_KEY, String(clamped));
    if (rendition) {
      try { rendition.themes.fontSize(`${clamped}%`); } catch (_) {}
    }
  }

  async function buildEpubUrl(id) {
    // Server requires /<token>/... on every request. Use loopback for the
    // reader regardless of LAN IP — the token is the actual auth boundary.
    const info = await window.airshelf.serverInfo();
    return `http://127.0.0.1:${info.port}/${info.token}/epub/${id}`;
  }

  function setTocOpen(open) {
    tocEl.classList.toggle('open', open);
    tocBtn.setAttribute('aria-expanded', String(open));
  }

  async function openReader(bookMeta) {
    if (!bookMeta || !bookMeta.id) return;
    currentBookId = bookMeta.id;
    titleEl.textContent = bookMeta.title || '';
    authorEl.textContent = [bookMeta.author, bookMeta.year].filter(Boolean).join(' · ');
    readerEl.classList.add('active');
    setTocOpen(false);

    // Reset progress/locations state before swapping books — otherwise the
    // previous book's locations stay marked ready while the new book's
    // index is still building, producing junk percentages.
    locationsReady = false;
    currentLocation = null;
    if (progressEl) progressEl.value = '0';
    if (posEl) posEl.textContent = '—';

    // Tear down any previous rendition before swapping books.
    if (rendition) {
      try { rendition.destroy(); } catch (_) {}
      rendition = null;
    }
    if (book) {
      try { book.destroy(); } catch (_) {}
      book = null;
    }
    viewportEl.innerHTML = '';

    const epubUrl = await buildEpubUrl(bookMeta.id);
    console.log('[reader] opening book', bookMeta.id);
    try {
      // Fetch the bytes ourselves so we get a real error instead of an
      // opaque epubjs failure if the URL/CORS misbehaves.
      const resp = await fetch(epubUrl);
      if (!resp.ok) throw new Error(`server returned ${resp.status}`);
      const ab = await resp.arrayBuffer();
      console.log('[reader] fetched', ab.byteLength, 'bytes');
      book = ePub(ab);
    } catch (e) {
      console.error('[reader] fetch failed', e);
      const errorMessage = e?.message ?? String(e);
      const errorEl = document.createElement('div');
      errorEl.style.padding = '32px';
      errorEl.style.color = '#b00';
      errorEl.style.font = '14px system-ui';
      errorEl.textContent = `Reader failed to load: ${errorMessage}`;
      viewportEl.replaceChildren(errorEl);
      return;
    }
    rendition = book.renderTo(viewportEl, {
      width: '100%',
      height: '100%',
      flow: 'paginated',
      manager: 'default',
      spread: 'auto',
      allowScriptedContent: false,
    });

    rendition.themes.default({
      'body': { 'padding': '0 !important' },
      'p': { 'line-height': '1.6 !important' },
      'img': { 'max-width': '100% !important', 'height': 'auto !important' },
    });
    rendition.themes.register('light', READER_THEMES.light);
    rendition.themes.register('dark', READER_THEMES.dark);
    applyReaderTheme(resolveDefaultTheme());
    rendition.themes.fontSize(`${getFontPct()}%`);

    const savedCfi = localStorage.getItem(LOC_KEY(bookMeta.id));
    try {
      await rendition.display(savedCfi || undefined);
      console.log('[reader] displayed');
    } catch (e) {
      console.error('[reader] display failed', e);
      try { await rendition.display(); } catch (_) {}
    }
    rendition.on('rendered', (section) => {
      console.log('[reader] rendered section', section && section.href);
    });

    rendition.on('relocated', (loc) => {
      currentLocation = loc;
      if (loc && loc.start && loc.start.cfi) {
        localStorage.setItem(LOC_KEY(currentBookId), loc.start.cfi);
      }
      updateProgress(loc);
    });

    // Forward keystrokes from inside the iframe so arrows turn pages even
    // when the rendered document has focus.
    rendition.on('keyup', handleKeyForward);
    rendition.on('keydown', handleKeyForward);
    rendition.on('click', () => {
      if (tocEl.classList.contains('open')) {
        setTocOpen(false);
      }
    });

    // Build locations index for the progress slider — backgrounded; the
    // reader is usable before it finishes.
    book.ready
      .then(() => buildToc())
      .then(() => book.locations.generate(1600))
      .then(() => {
        locationsReady = true;
        if (currentLocation) updateProgress(currentLocation);
      })
      .catch((e) => console.warn('locations/toc:', e));
  }

  function closeReader() {
    if (rendition) { try { rendition.destroy(); } catch (_) {} rendition = null; }
    if (book) { try { book.destroy(); } catch (_) {} book = null; }
    viewportEl.innerHTML = '';
    readerEl.classList.remove('active');
    currentBookId = null;
    locationsReady = false;
  }

  function updateProgress(loc) {
    if (!loc || !loc.start) return;
    if (locationsReady && book && book.locations) {
      const pct = book.locations.percentageFromCfi(loc.start.cfi);
      if (typeof pct === 'number' && !Number.isNaN(pct)) {
        progressEl.value = String(Math.round(pct * 1000));
        posEl.textContent = `${Math.round(pct * 100)}%`;
        return;
      }
    }
    posEl.textContent = loc.start.displayed
      ? `${loc.start.displayed.page}/${loc.start.displayed.total}`
      : '—';
  }

  async function buildToc() {
    if (!book) return;
    const nav = await book.loaded.navigation;
    tocList.innerHTML = '';
    const flatten = (items, depth) => {
      for (const item of items) {
        const li = document.createElement('li');
        // Real <button> instead of <a> without href — focusable via Tab,
        // activates on Enter/Space without extra handlers.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label.trim();
        btn.className = `toc-depth-${Math.min(depth, 2)}`;
        btn.addEventListener('click', () => {
          if (rendition) rendition.display(item.href);
          setTocOpen(false);
        });
        li.appendChild(btn);
        tocList.appendChild(li);
        if (item.subitems && item.subitems.length) flatten(item.subitems, depth + 1);
      }
    };
    flatten(nav.toc || [], 0);
  }

  function handleKeyForward(e) {
    if (!readerEl.classList.contains('active')) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault?.();
      rendition && rendition.prev();
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault?.();
      rendition && rendition.next();
    } else if (e.key === 'Escape') {
      closeReader();
    } else if (e.key === '+' || e.key === '=') {
      setFontPct(getFontPct() + FONT_STEP);
    } else if (e.key === '-' || e.key === '_') {
      setFontPct(getFontPct() - FONT_STEP);
    }
  }

  // Wire UI
  closeBtn.addEventListener('click', closeReader);
  prevZone.addEventListener('click', () => rendition && rendition.prev());
  nextZone.addEventListener('click', () => rendition && rendition.next());
  fontUpBtn.addEventListener('click', () => setFontPct(getFontPct() + FONT_STEP));
  fontDownBtn.addEventListener('click', () => setFontPct(getFontPct() - FONT_STEP));
  themeBtn.addEventListener('click', () => {
    const next = themeBtn.getAttribute('aria-pressed') === 'true' ? 'light' : 'dark';
    setReaderTheme(next);
  });
  tocBtn.addEventListener('click', () => {
    const open = !tocEl.classList.contains('open');
    setTocOpen(open);
  });

  progressEl.addEventListener('change', () => {
    if (!locationsReady || !book || !rendition) return;
    const pct = parseInt(progressEl.value, 10) / 1000;
    const cfi = book.locations.cfiFromPercentage(pct);
    if (cfi) rendition.display(cfi);
  });

  document.addEventListener('keydown', handleKeyForward);

  window.addEventListener('resize', () => {
    if (!rendition) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try { rendition.resize(); } catch (_) {}
    }, 150);
  });

  // Expose a tiny API for renderer.js
  window.airshelfReader = { open: openReader, close: closeReader };
})();
