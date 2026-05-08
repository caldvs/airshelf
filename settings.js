// Tiny key/value store backed by a single JSON file. Pulled out of main.js
// so the load/save semantics (cache, atomic write, type-checked parse) can
// be unit-tested without spinning up Electron.
//
// The set of fields persisted here is deliberately tiny — anything bigger
// (themes, library state, etc.) belongs in localStorage on the renderer
// side or in books.json. Today the only entry is `calibreBinDir` for #29.
//
// Each store is bound to one path via `createSettingsStore(path)` so tests
// can spin up isolated stores against a tmpdir without touching shared
// module state.

const fs = require('fs');

function createSettingsStore(filePath) {
  // Cache the parsed object so repeated load() calls don't re-read the
  // disk. Save() writes through the cache before persisting so a load()
  // following a save() always returns the new value, even if the disk
  // write hadn't finished syncing yet.
  let cache = null;

  function load() {
    if (cache) return cache;
    if (!filePath) {
      cache = {};
      return cache;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Plain object only — reject arrays (typeof [] === 'object') and
      // null. A malformed/tampered settings.json shouldn't poison save(),
      // which spreads the loaded value into a fresh object expecting
      // string keys.
      cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      cache = {};
    }
    return cache;
  }

  function save(patch) {
    const next = { ...load(), ...patch };
    // Drop nulls so calling save({ calibreBinDir: null }) actually forgets
    // the key rather than persisting a `null` value the consumer would
    // then have to defend against.
    for (const k of Object.keys(next)) {
      if (next[k] == null) delete next[k];
    }
    cache = next;
    if (!filePath) return next;
    // Atomic write: tmp file + rename. A crash mid-write leaves the
    // previous settings.json intact rather than truncated.
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, filePath);
    return next;
  }

  return { load, save };
}

module.exports = { createSettingsStore };
