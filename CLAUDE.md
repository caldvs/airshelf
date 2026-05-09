# Project Instructions

## Commands

```bash
npm start                       # run app (Electron)
npm run build                   # bundle .app (electron-builder, macOS)
npm run typecheck               # tsc --noEmit
npm test                        # vitest (.test.mjs, ESM-only)
npm test -- auth.test.mjs       # single file
```

## Architecture

- `src/electron/main.ts` — Electron main process. Compiled to `out/electron/main.js`; `package.json` `"main"` points there.
- `src/electron/preload.ts` — bridges renderer↔main via `contextBridge`. Compiled to `out/electron/preload.js`; loaded by main via `path.join(__dirname, 'preload.js')` (sibling).
- `src/lib/` — pure helpers (hash, concurrency, utils, safety, titles).
- `src/domain/` — domain logic (auth, pair, settings, backup).
- `src/integrations/` — external integrations (calibre, openlibrary, goodreads, inject-asin).
- `src/server/routes/` — HTTP route modules (auth, range, download, pair, upload, cover, epub, index).
- `tsc` compiles `src/` → `out/` preserving structure. `prestart`/`prebuild`/`pretest` hooks run `npm run compile` (rimraf out && tsc).
- App-rooted paths use `app.getAppPath()` (application root: repo root in dev, `app.asar` bundle in prod) — not `__dirname` (which inside the compiled main is `out/electron/`). Anything resolved this way must be present in `package.json` `build.files` so it's bundled into the asar.
- `renderer/`. UI (HTML/CSS/vanilla JS, no framework). Loaded via `app.getAppPath()`.

## Don'ts

- No `require` or direct FS access in `renderer/`. Bridge through `preload.js`.
