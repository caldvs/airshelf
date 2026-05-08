# Send to Airshelf — browser extension

A Manifest V3 extension that sends the current page (typically a PDF or
direct ebook URL) to a running Airshelf instance, which then converts and
serves it to your Kindle.

## Status

MVP. PDFs and direct ebook URLs (`.epub`, `.mobi`, `.azw3`) work today.
Article-to-EPUB conversion (Mozilla Readability + epub-gen) is a planned
follow-up — for now use the in-app reader instead.

## Install (developer mode)

The extension isn't published to the Chrome Web Store yet.

1. Open `chrome://extensions/` (or `edge://extensions/` /
   `brave://extensions/`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this `extension/` directory.

For Firefox / Safari: Manifest V3 is supported but the install flow
differs; `web-ext` and Xcode tooling respectively are needed. Not yet
documented here.

## Pair

1. Open Airshelf on your Mac. The **Send** tab shows your Kindle URL,
   e.g. `http://127.0.0.1:6790/abcdef/`.
2. Click the extension's toolbar icon → paste that URL into the popup →
   **Pair**.

The token is stored in `chrome.storage.local` and never synced. Repair
after a token rotation.

## Send

With Airshelf running and the extension paired:

1. Browse to a PDF or direct ebook URL.
2. Click the extension icon → **Send current page**.

The extension fetches the URL bytes in the browser, then `POST`s them
to the Airshelf `/upload` endpoint over loopback. Airshelf converts
(via Calibre, if needed) and the file becomes available on the Kindle
URL.

## Why loopback only

Airshelf's `/upload` endpoint refuses non-loopback connections —
non-loopback writes would let any device on the LAN inject books into
your library. The extension and Airshelf both run on the same machine,
so the upload travels over `127.0.0.1` and never leaves it.

## Security notes

- The token in the Kindle URL is the auth boundary. Treat it like a
  password — anyone with that URL on your LAN can read your library.
- The extension never proxies the file through third-party servers; the
  fetch + upload happen in your browser locally.
