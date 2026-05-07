// Normalise the Kindle-facing metadata inside a MOBI/AZW3 file so the
// experimental browser's sideload pipeline treats the book as a Personal
// Document (PDOC). This is what makes Kindle's library indexer generate a
// cover thumbnail from the embedded EXTH 201 cover image.
//
// Earlier versions of this module injected a fake Amazon ASIN plus
// cdetype=EBOK, on the theory that Kindle would treat the file as a native
// Amazon ebook. Empirically the opposite happens on recent firmware: the
// indexer tries to look up the (non-existent) ASIN in the Amazon catalogue,
// fails, and shows no cover at all. Comparing against Bookify's output
// (which reliably renders covers) showed cdetype=PDOC and no 504 record.
//
// Format references:
//   PDB header:        https://wiki.mobileread.com/wiki/PDB
//   MOBI/EXTH header:  https://wiki.mobileread.com/wiki/MOBI

const fs = require('fs');

function buildExthRecord(type, data) {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
  const rec = Buffer.alloc(8 + dataBuf.length);
  rec.writeUInt32BE(type, 0);
  rec.writeUInt32BE(8 + dataBuf.length, 4);
  dataBuf.copy(rec, 8);
  return rec;
}

function findMobiHeaders(buf) {
  const headers = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x4d && buf[i + 1] === 0x4f &&
        buf[i + 2] === 0x42 && buf[i + 3] === 0x49) {
      headers.push(i);
    }
  }
  return headers;
}

// Rebuild a single EXTH section: replace 501 with PDOC, drop 504, keep
// everything else. Returns { patched, delta }.
function rewriteExthSection(record0, mobiHeaderOffset) {
  const mobiHeaderLength = record0.readUInt32BE(mobiHeaderOffset + 4);
  const exthStart = mobiHeaderOffset + mobiHeaderLength;
  if (exthStart + 12 > record0.length ||
      record0.slice(exthStart, exthStart + 4).toString('ascii') !== 'EXTH') {
    return { patched: record0, delta: 0 };
  }

  // Make sure the EXTH-present flag is set in the MOBI header.
  const flagOffset = mobiHeaderOffset + 0x80;
  if (flagOffset + 4 <= record0.length) {
    const flag = record0.readUInt32BE(flagOffset);
    if ((flag & 0x40) === 0) record0.writeUInt32BE(flag | 0x40, flagOffset);
  }

  const exthLength = record0.readUInt32BE(exthStart + 4);
  const exthRecordCount = record0.readUInt32BE(exthStart + 8);

  let cursor = exthStart + 12;
  const kept = [];
  for (let i = 0; i < exthRecordCount; i++) {
    const type = record0.readUInt32BE(cursor);
    const len = record0.readUInt32BE(cursor + 4);
    // 504 (AmazonId) is dropped so Kindle doesn't try a cloud lookup for
    // a non-existent ASIN. All 501 (cdetype) records are dropped here and
    // replaced below with exactly one canonical 501="PDOC" — that makes
    // this rewrite idempotent (a file with two 501 records, e.g. from a
    // previous tool that didn't dedup, won't end up with two 501="PDOC"
    // records after one pass).
    if (type !== 504 && type !== 501) {
      kept.push(Buffer.from(record0.slice(cursor, cursor + len)));
    }
    cursor += len;
  }
  kept.push(buildExthRecord(501, 'PDOC'));

  const newBody = Buffer.concat(kept);
  const pad = (4 - (newBody.length % 4)) % 4;
  const paddedBody = Buffer.concat([newBody, Buffer.alloc(pad, 0)]);
  const newExthLength = 12 + paddedBody.length;
  const delta = newExthLength - exthLength;

  const out = Buffer.concat([
    record0.slice(0, exthStart + 12),
    paddedBody,
    record0.slice(exthStart + exthLength),
  ]);
  out.writeUInt32BE(newExthLength, exthStart + 4);
  out.writeUInt32BE(kept.length, exthStart + 8);

  // Shift the MOBI full-name offset if the title lived after the EXTH.
  const fullNameOffset = out.readUInt32BE(mobiHeaderOffset + 0x44);
  if (fullNameOffset >= exthStart + exthLength) {
    out.writeUInt32BE(fullNameOffset + delta, mobiHeaderOffset + 0x44);
  }

  return { patched: out, delta };
}

function normalizeKindleMetadata(filePath) {
  const buf = fs.readFileSync(filePath);

  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 1) return false;

  const record0Start = buf.readUInt32BE(78);
  const record1Start = numRecords > 1 ? buf.readUInt32BE(78 + 8) : buf.length;
  const originalRecord0 = buf.slice(record0Start, record1Start);

  const allMobis = findMobiHeaders(buf);
  const mobisInRecord0 = allMobis
    .filter(o => o >= record0Start && o < record1Start)
    .map(o => o - record0Start);
  if (mobisInRecord0.length === 0) return false;

  let working = Buffer.from(originalRecord0);
  let totalDelta = 0;
  for (const baseOffset of mobisInRecord0) {
    const offset = baseOffset + totalDelta;
    const { patched, delta } = rewriteExthSection(working, offset);
    working = patched;
    totalDelta += delta;
  }

  const out = Buffer.concat([
    buf.slice(0, record0Start),
    working,
    buf.slice(record1Start),
  ]);

  for (let i = 1; i < numRecords; i++) {
    const entryAt = 78 + i * 8;
    const off = out.readUInt32BE(entryAt);
    out.writeUInt32BE(off + totalDelta, entryAt);
  }

  fs.writeFileSync(filePath, out);
  return true;
}

module.exports = { normalizeKindleMetadata, rewriteExthSection, buildExthRecord };
