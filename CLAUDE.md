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

- `main.js`, `preload.js`, `inject-asin.js`. Hand-written JS at root. `main.js` is the Electron main process; `preload.js` bridges renderer↔main via `contextBridge`; `inject-asin.js` runs inside Amazon's Send-to-Kindle page.
- `src/*.ts`. TS modules organised by role: `src/lib/` for pure helpers (hash, concurrency, utils, safety, titles), `src/domain/` for domain logic (auth, …). Compiled to `out/` via `tsc` and imported by root `.js` files (e.g. `require('./out/lib/hash.js')`). `prestart`/`prebuild`/`pretest` hooks run `npm run compile` (rimraf out && tsc).
- `renderer/`. UI (HTML/CSS/vanilla JS, no framework).

## Don'ts

- No `require` or direct FS access in `renderer/`. Bridge through `preload.js`.
