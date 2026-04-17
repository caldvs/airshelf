// Inject Amazon ASIN / cdetype metadata into a MOBI/AZW3 file by directly
// patching the EXTH header. This is what tells Kindle's library indexer to
// treat the file as a native Amazon ebook (and reliably generate a library
// cover thumbnail) rather than as a "Personal Document".
//
// Format references:
//   PDB header:        https://wiki.mobileread.com/wiki/PDB
//   MOBI/EXTH header:  https://wiki.mobileread.com/wiki/MOBI
//
// The records we inject:
//   113 (ASIN)         — fake B0-prefixed ASIN string
//   501 (cdetype)      — "EBOK" → "Amazon ebook"
//   504 (AmazonId)     — duplicate of ASIN

const fs = require('fs');
const crypto = require('crypto');

// Generate a deterministic fake ASIN for a book id. Real ASINs are 10
// characters starting with B0; we keep the same shape so Kindle's indexer
// is happy. Deterministic so re-injection produces the same value.
function fakeAsinForId(id) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const hash = crypto.createHash('sha1').update(String(id)).digest();
  let s = 'B0';
  for (let i = 0; i < 8; i++) {
    s += ALPHABET[hash[i] % ALPHABET.length];
  }
  return s;
}

function buildExthRecord(type, data) {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
  const rec = Buffer.alloc(8 + dataBuf.length);
  rec.writeUInt32BE(type, 0);
  rec.writeUInt32BE(8 + dataBuf.length, 4); // total length including 8-byte header
  dataBuf.copy(rec, 8);
  return rec;
}

// Locate every "MOBI" header inside record 0. AZW3/KF8 files often contain
// two MOBI headers (the legacy MOBI6 wrapper and the KF8 header). We patch
// the EXTH that follows each one so Kindle reads consistent metadata
// regardless of which half it indexes from.
function findMobiHeaders(record0) {
  const headers = [];
  let i = 0;
  while (i + 4 <= record0.length) {
    if (record0[i] === 0x4d && record0[i + 1] === 0x4f &&
        record0[i + 2] === 0x42 && record0[i + 3] === 0x49) { // "MOBI"
      headers.push(i);
      i += 4;
    } else {
      i += 1;
    }
  }
  return headers;
}

// Patch a single EXTH section in a buffer (the buffer is a slice — caller
// reassembles). Returns { patched: Buffer, delta: number }.
function patchExthSection(record0, mobiHeaderOffset, asin) {
  const mobiHeaderLength = record0.readUInt32BE(mobiHeaderOffset + 4);
  // Calibre's AZW3 output writes the EXTH section but doesn't set the
  // bit-6 flag in the MOBI header. So instead of trusting the flag we just
  // check for the EXTH magic directly after the MOBI header.
  const exthStart = mobiHeaderOffset + mobiHeaderLength;
  if (exthStart + 12 > record0.length ||
      record0.slice(exthStart, exthStart + 4).toString('ascii') !== 'EXTH') {
    return { patched: record0, delta: 0 };
  }
  // While we're here, set the EXTH flag bit so other readers know it exists
  const flagOffset = mobiHeaderOffset + 0x80;
  if (flagOffset + 4 <= record0.length) {
    const flag = record0.readUInt32BE(flagOffset);
    if ((flag & 0x40) === 0) {
      record0.writeUInt32BE(flag | 0x40, flagOffset);
    }
  }

  const exthLength = record0.readUInt32BE(exthStart + 4);
  const exthRecordCount = record0.readUInt32BE(exthStart + 8);

  // Walk records, note which already exist, and find where to insert.
  const existing = new Set();
  let cursor = exthStart + 12;
  for (let i = 0; i < exthRecordCount; i++) {
    const type = record0.readUInt32BE(cursor);
    const len = record0.readUInt32BE(cursor + 4);
    existing.add(type);
    cursor += len;
  }
  const insertOffset = cursor; // end of last existing record (before EXTH padding)

  const newRecords = [];
  if (!existing.has(113)) newRecords.push(buildExthRecord(113, asin));
  if (!existing.has(501)) newRecords.push(buildExthRecord(501, 'EBOK'));
  if (!existing.has(504)) newRecords.push(buildExthRecord(504, asin));

  if (newRecords.length === 0) {
    return { patched: record0, delta: 0 };
  }

  const insertBuf = Buffer.concat(newRecords);
  // EXTH section must remain 4-byte aligned. Pad the insertion so the
  // following bytes (existing padding + full title) keep their alignment.
  const insertLen = insertBuf.length;
  const padNeeded = (4 - (insertLen % 4)) % 4;
  const paddedInsert = Buffer.concat([insertBuf, Buffer.alloc(padNeeded, 0)]);
  const delta = paddedInsert.length;

  // Splice the new records into record 0
  const out = Buffer.concat([
    record0.slice(0, insertOffset),
    paddedInsert,
    record0.slice(insertOffset),
  ]);

  // Update EXTH header length and record count in place
  out.writeUInt32BE(exthLength + delta, exthStart + 4);
  out.writeUInt32BE(exthRecordCount + newRecords.length, exthStart + 8);

  // The MOBI header has a "full name offset" field (offset 0x44) that
  // points to the book title bytes inside record 0. If our insertion
  // landed before the title, push that offset forward by the delta.
  const fullNameOffset = out.readUInt32BE(mobiHeaderOffset + 0x44);
  if (fullNameOffset >= insertOffset) {
    out.writeUInt32BE(fullNameOffset + delta, mobiHeaderOffset + 0x44);
  }

  return { patched: out, delta };
}

function injectAmazonAsin(filePath, asin) {
  const buf = fs.readFileSync(filePath);

  // PDB header: 78 bytes fixed, then numberOfRecords at offset 76 (BE u16)
  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 1) return false;

  // Each record info entry is 8 bytes starting at byte 78:
  //   offset (BE u32) | attrs (u8) | uid (3 bytes BE)
  const record0Start = buf.readUInt32BE(78);
  const record1Start = numRecords > 1 ? buf.readUInt32BE(78 + 8) : buf.length;
  const originalRecord0 = buf.slice(record0Start, record1Start);

  // Inside record 0: PalmDoc header (16 bytes) then MOBI header(s)
  const mobiOffsets = findMobiHeaders(originalRecord0);
  if (mobiOffsets.length === 0) return false;

  // Patch each MOBI header's EXTH in turn
  let working = originalRecord0;
  let totalDelta = 0;
  for (const baseOffset of mobiOffsets) {
    // baseOffset was computed against the original buffer; account for any
    // earlier insertions by shifting forward by totalDelta.
    const offset = baseOffset + totalDelta;
    const { patched, delta } = patchExthSection(working, offset, asin);
    working = patched;
    totalDelta += delta;
  }

  if (totalDelta === 0) return true; // already had the records

  // Reassemble the file: original header + record info table + (everything
  // before record 0) + new record 0 + (everything after old record 0)
  const out = Buffer.concat([
    buf.slice(0, record0Start),
    working,
    buf.slice(record1Start),
  ]);

  // Shift PDB record offsets for every record after record 0
  for (let i = 1; i < numRecords; i++) {
    const entryAt = 78 + i * 8;
    const off = out.readUInt32BE(entryAt);
    out.writeUInt32BE(off + totalDelta, entryAt);
  }

  fs.writeFileSync(filePath, out);
  return true;
}

module.exports = { injectAmazonAsin, fakeAsinForId };
