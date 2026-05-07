# Project Instructions

## Commands

```bash
npm start                       # run app (Electron)
npm run build                   # bundle .app (electron-builder, macOS)
npm run typecheck               # tsc --noEmit
npm test                        # vitest (no tests written yet)
npm test -- src/foo.test.ts     # single file
```

## Architecture

- `main.js`, `preload.js`, `inject-asin.js`. Hand-written JS at root. `main.js` is the Electron main process; `preload.js` bridges renderer↔main via `contextBridge`; `inject-asin.js` runs inside Amazon's Send-to-Kindle page.
- `src/*.ts`. TS modules (titles, types, utils) compiled to `dist/`, imported by `main.js`.
- `renderer/`. UI (HTML/CSS/vanilla JS, no framework).

## Don'ts

- No `require` or direct FS access in `renderer/`. Bridge through `preload.js`.
