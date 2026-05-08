import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, 'airshelf.js');
const cliMod = await import('./airshelf.js');
const { humanSize, readToken, readBooks, userDataDir } = cliMod.default ?? cliMod;

describe('humanSize', () => {
  it('formats sub-KB as bytes', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(1023)).toBe('1023 B');
  });

  it('formats KB-range with one decimal', () => {
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it('formats MB-range with one decimal', () => {
    expect(humanSize(1024 * 1024)).toBe('1.0 MB');
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('handles bad input without crashing', () => {
    expect(humanSize(NaN)).toBe('?');
    expect(humanSize(-1)).toBe('?');
    expect(humanSize('huge')).toBe('?');
    expect(humanSize(undefined)).toBe('?');
  });
});

describe('userDataDir (per-platform shape)', () => {
  it('returns an absolute path containing the product name', () => {
    const p = userDataDir();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toContain('Airshelf');
  });

  it('honours an explicit product name override', () => {
    const p = userDataDir('Custom');
    expect(p).toContain('Custom');
    expect(p).not.toContain('/Airshelf');
  });
});

describe('readToken / readBooks (filesystem)', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-cli-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('readToken returns null when no file exists', () => {
    expect(readToken(tmp)).toBeNull();
  });

  it('readToken returns null for malformed token', () => {
    fs.writeFileSync(path.join(tmp, 'server-token'), 'NOTLOWERCASE');
    expect(readToken(tmp)).toBeNull();
  });

  it('readToken returns the token when valid', () => {
    fs.writeFileSync(path.join(tmp, 'server-token'), 'abcdef\n');
    expect(readToken(tmp)).toBe('abcdef');
  });

  it('readBooks returns [] for missing/invalid books.json', () => {
    expect(readBooks(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'books.json'), 'not json');
    expect(readBooks(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'books.json'), '{"books":"nope"}');
    expect(readBooks(tmp)).toEqual([]);
  });

  it('readBooks returns the array when present', () => {
    const books = [{ id: 'a', title: 'X', author: 'Y', size: 1234 }];
    fs.writeFileSync(path.join(tmp, 'books.json'), JSON.stringify({ books }));
    expect(readBooks(tmp)).toEqual(books);
  });
});

describe('CLI invocation (black box)', () => {
  it('-h prints usage and exits 0', async () => {
    const { stdout } = await exec(process.execPath, [cliPath, '-h']);
    expect(stdout).toMatch(/airshelf — read-only CLI/);
    expect(stdout).toMatch(/url\b/);
    expect(stdout).toMatch(/list\b/);
  });

  it('unknown command exits non-zero with stderr message', async () => {
    await expect(
      exec(process.execPath, [cliPath, 'frobnicate']),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringMatching(/unknown command/),
    });
  });
});
