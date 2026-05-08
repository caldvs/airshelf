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

// Keys we refuse to copy out of a parsed settings.json or accept from a
// caller's `save(patch)`. A tampered file containing `__proto__` could
// otherwise mutate the prototype chain when spread into a fresh object,
// turning a settings file into a prototype-pollution vector.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Copy own enumerable keys from `src` into a fresh null-prototype object,
// skipping FORBIDDEN_KEYS. Used both at load (sanitise what's on disk)
// and at save (sanitise the caller's patch).
function sanitise(src) {
  const out = Object.create(null);
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const k of Object.keys(src)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = src[k];
  }
  return out;
}

function createSettingsStore(filePath) {
  // Cache the parsed object so repeated load() calls don't re-read the
  // disk. Save() writes through the cache before persisting so a load()
  // following a save() always returns the new value, even if the disk
  // write hadn't finished syncing yet.
  let cache = null;

  function load() {
    if (cache) return cache;
    if (!filePath) {
      cache = sanitise(null);
      return cache;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Plain object only — reject arrays (typeof [] === 'object') and
      // null. A malformed/tampered settings.json shouldn't poison save();
      // sanitise() additionally drops `__proto__`-style keys before they
      // reach the spread in save().
      cache = sanitise(raw);
    } catch {
      cache = sanitise(null);
    }
    return cache;
  }

  function save(patch) {
    // Sanitise both halves: load() already sanitised the loaded object,
    // but the caller's `patch` could still carry __proto__ if it came
    // from JSON.parse upstream. Build into a null-prototype object so
    // even an undetected forbidden key can't reach Object.prototype.
    const cleanPatch = sanitise(patch);
    const next = Object.create(null);
    Object.assign(next, load(), cleanPatch);
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
