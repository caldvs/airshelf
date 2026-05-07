import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokensMatch, loadOrCreateServerToken } from './auth.js';

describe('tokensMatch', () => {
  it('matches identical strings', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });

  it('rejects different lengths (no timingSafeEqual throw)', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(tokensMatch(null, 'x')).toBe(false);
    expect(tokensMatch('x', undefined)).toBe(false);
    expect(tokensMatch(123, '123')).toBe(false);
  });

  it('treats two empty strings as equal (caller must reject empty serverToken)', () => {
    expect(tokensMatch('', '')).toBe(true);
    expect(tokensMatch('', 'x')).toBe(false);
  });
});

describe('loadOrCreateServerToken', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-auth-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a 32-hex token on first call and persists it', () => {
    const t = loadOrCreateServerToken(dir);
    expect(t).toMatch(/^[a-f0-9]{32}$/);
    const onDisk = fs.readFileSync(path.join(dir, 'server-token'), 'utf8').trim();
    expect(onDisk).toBe(t);
  });

  it('reuses the persisted token on subsequent calls', () => {
    const a = loadOrCreateServerToken(dir);
    const b = loadOrCreateServerToken(dir);
    expect(b).toBe(a);
  });

  it('regenerates if the persisted token is malformed', () => {
    fs.writeFileSync(path.join(dir, 'server-token'), 'not-a-real-token');
    const t = loadOrCreateServerToken(dir);
    expect(t).toMatch(/^[a-f0-9]{32}$/);
    expect(t).not.toBe('not-a-real-token');
  });

  it('writes the file with 0600 permissions', () => {
    loadOrCreateServerToken(dir);
    const stat = fs.statSync(path.join(dir, 'server-token'));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
