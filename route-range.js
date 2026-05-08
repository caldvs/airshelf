// HTTP byte-range parsing for the /epub route.
//
// epubjs reads big books in chunks via Range, so the server has to honour
// `Range: bytes=<start>-<end>`. The arithmetic is the kind of thing that
// breaks silently in subtle ways (off-by-one on the inclusive end, ranges
// past EOF, backwards ranges), so it's pulled out of main.js and tested.

// Parses the inbound `Range` header against a known total size and returns
// the response shape the caller should send.
//
// Returns:
//   null
//     The header is absent or unparseable; caller should serve a full 200.
//   { status: 416, headers: { 'Content-Range': 'bytes */<size>' } }
//     The range is satisfiable in shape but lies outside the resource;
//     caller should send 416 (Range Not Satisfiable) with no body.
//   { status: 206, start, end, headers: { 'Content-Range', 'Content-Length' } }
//     The range is valid; caller should stream bytes [start, end] inclusive.
//
// `start` and `end` are inclusive — fs.createReadStream({ start, end })
// expects this same convention.
function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const requestedEnd = m[2] ? parseInt(m[2], 10) : totalSize - 1;
  if (start >= totalSize || requestedEnd < start) {
    return {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}` },
    };
  }
  const end = Math.min(requestedEnd, totalSize - 1);
  return {
    status: 206,
    start,
    end,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': end - start + 1,
    },
  };
}

module.exports = { parseRangeHeader };
