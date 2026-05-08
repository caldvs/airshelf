import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashFileSha1 } from './lib/hash.js';

describe('hashFileSha1', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-hash-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hashes an empty file', async () => {
    const f = path.join(dir, 'empty');
    fs.writeFileSync(f, Buffer.alloc(0));
    expect(await hashFileSha1(f)).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('hashes a small file', async () => {
    const f = path.join(dir, 'hello');
    fs.writeFileSync(f, 'hello');
    expect(await hashFileSha1(f)).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
  });

  it('matches the all-in-memory SHA-1 of the same bytes', async () => {
    const f = path.join(dir, 'random');
    const bytes = crypto.randomBytes(2 * 1024 * 1024); // 2 MiB
    fs.writeFileSync(f, bytes);
    const expected = crypto.createHash('sha1').update(bytes).digest('hex');
    expect(await hashFileSha1(f)).toBe(expected);
  });

  it('produces stable output across calls (deterministic)', async () => {
    const f = path.join(dir, 'stable');
    fs.writeFileSync(f, 'consistent input');
    const a = await hashFileSha1(f);
    const b = await hashFileSha1(f);
    expect(b).toBe(a);
  });

  it('rejects when the file does not exist', async () => {
    await expect(hashFileSha1(path.join(dir, 'missing'))).rejects.toThrow();
  });
});
