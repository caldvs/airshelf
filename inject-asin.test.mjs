import { describe, it, expect } from 'vitest';
import { rewriteExthSection, buildExthRecord } from './out/integrations/inject-asin.js';

// Build a minimal record0 buffer containing one MOBI header at offset 0
// and an EXTH section right after, with the given list of records.
//
// MOBI header layout used here:
//   0x00  4 bytes  "MOBI" magic
//   0x04  4 bytes  header length (= MOBI_LEN, 0x84 below — sized to include
//                  the EXTH-present flag at 0x80)
//   0x44  4 bytes  full-name offset (set after EXTH end so the function
//                  doesn't try to shift it through our test data)
//   0x80  4 bytes  EXTH-present flag (set by rewriteExthSection on success;
//                  the function only ever sets it, never clears it)
function makeRecord0(exthRecords) {
  const MOBI_LEN = 0x84; // include the EXTH flag at 0x80
  const exthBody = Buffer.concat(exthRecords.map(({ type, data }) => buildExthRecord(type, data)));
  const exthHeader = Buffer.alloc(12);
  exthHeader.write('EXTH', 0, 'ascii');
  exthHeader.writeUInt32BE(12 + exthBody.length, 4);
  exthHeader.writeUInt32BE(exthRecords.length, 8);
  const exth = Buffer.concat([exthHeader, exthBody]);

  const mobi = Buffer.alloc(MOBI_LEN);
  mobi.write('MOBI', 0, 'ascii');
  mobi.writeUInt32BE(MOBI_LEN, 4);
  // Set full-name offset past the EXTH so the function doesn't try to shift it.
  mobi.writeUInt32BE(MOBI_LEN + exth.length + 100, 0x44);
  // EXTH-present flag starts unset; the function should set it.
  mobi.writeUInt32BE(0, 0x80);

  return Buffer.concat([mobi, exth]);
}

// Walk the EXTH records in `record0` (assuming MOBI at offset 0) and
// return a list of {type, data}. Used to assert post-rewrite shape.
function readExthRecords(record0) {
  const mobiLen = record0.readUInt32BE(4);
  const exthStart = mobiLen;
  if (record0.slice(exthStart, exthStart + 4).toString('ascii') !== 'EXTH') {
    return null;
  }
  const count = record0.readUInt32BE(exthStart + 8);
  const out = [];
  let cursor = exthStart + 12;
  for (let i = 0; i < count; i++) {
    const type = record0.readUInt32BE(cursor);
    const len = record0.readUInt32BE(cursor + 4);
    out.push({ type, data: record0.slice(cursor + 8, cursor + len).toString('latin1') });
    cursor += len;
  }
  return out;
}

describe('rewriteExthSection', () => {
  it('adds a single 501=PDOC when input has no 501 record', () => {
    const input = makeRecord0([{ type: 100, data: 'Some Author' }]);
    const { patched } = rewriteExthSection(input, 0);
    const records = readExthRecords(patched);
    const cdetype = records.filter((r) => r.type === 501);
    expect(cdetype).toHaveLength(1);
    expect(cdetype[0].data).toBe('PDOC');
    // Pre-existing record preserved.
    expect(records.find((r) => r.type === 100)).toEqual({ type: 100, data: 'Some Author' });
  });

  it('replaces a single 501 with a single 501=PDOC', () => {
    const input = makeRecord0([
      { type: 100, data: 'Some Author' },
      { type: 501, data: 'EBOK' },
    ]);
    const { patched } = rewriteExthSection(input, 0);
    const records = readExthRecords(patched);
    const cdetype = records.filter((r) => r.type === 501);
    expect(cdetype).toHaveLength(1);
    expect(cdetype[0].data).toBe('PDOC');
  });

  it('collapses multiple 501 records into a single 501=PDOC', () => {
    const input = makeRecord0([
      { type: 501, data: 'EBOK' },
      { type: 100, data: 'Some Author' },
      { type: 501, data: 'EBSP' },
      { type: 501, data: 'EBOK' },
    ]);
    const { patched } = rewriteExthSection(input, 0);
    const records = readExthRecords(patched);
    const cdetype = records.filter((r) => r.type === 501);
    expect(cdetype).toHaveLength(1);
    expect(cdetype[0].data).toBe('PDOC');
    // Non-501/504 records survive.
    expect(records.find((r) => r.type === 100)).toEqual({ type: 100, data: 'Some Author' });
  });

  it('drops 504 (AmazonId) records', () => {
    const input = makeRecord0([
      { type: 504, data: 'B00ABCDEF' },
      { type: 100, data: 'Some Author' },
    ]);
    const { patched } = rewriteExthSection(input, 0);
    const records = readExthRecords(patched);
    expect(records.find((r) => r.type === 504)).toBeUndefined();
  });

  it('is idempotent: rewrite(rewrite(x)) has the same shape as rewrite(x)', () => {
    const input = makeRecord0([
      { type: 501, data: 'EBOK' },
      { type: 501, data: 'EBOK' },
      { type: 100, data: 'Some Author' },
    ]);
    const once = rewriteExthSection(input, 0).patched;
    const twice = rewriteExthSection(once, 0).patched;
    expect(readExthRecords(twice)).toEqual(readExthRecords(once));
    expect(readExthRecords(twice).filter((r) => r.type === 501)).toHaveLength(1);
  });

  it('sets the EXTH-present flag on the MOBI header', () => {
    const input = makeRecord0([{ type: 100, data: 'x' }]);
    expect(input.readUInt32BE(0x80) & 0x40).toBe(0); // unset before
    const { patched } = rewriteExthSection(input, 0);
    expect(patched.readUInt32BE(0x80) & 0x40).toBe(0x40); // set after
  });

  it('returns the buffer unchanged when EXTH is absent', () => {
    // Build a record0 with a MOBI header but no following EXTH block.
    const mobi = Buffer.alloc(0x80);
    mobi.write('MOBI', 0, 'ascii');
    mobi.writeUInt32BE(0x80, 4);
    const padding = Buffer.alloc(20, 0); // anything but 'EXTH' at offset 0x80
    const input = Buffer.concat([mobi, padding]);
    const { patched, delta } = rewriteExthSection(input, 0);
    expect(patched).toBe(input);
    expect(delta).toBe(0);
  });
});
