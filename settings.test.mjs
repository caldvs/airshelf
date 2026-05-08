import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore } from './settings.js';

describe('createSettingsStore', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-settings-'));
    file = path.join(dir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when the backing file does not exist', () => {
    const store = createSettingsStore(file);
    expect(store.load()).toEqual({});
    // load() on a missing file should NOT create the file as a side effect.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('returns {} when no file path is bound', () => {
    const store = createSettingsStore(null);
    expect(store.load()).toEqual({});
  });

  it('reads + parses an existing file', () => {
    fs.writeFileSync(file, JSON.stringify({ calibreBinDir: '/opt/calibre' }));
    const store = createSettingsStore(file);
    expect(store.load()).toEqual({ calibreBinDir: '/opt/calibre' });
  });

  it('returns {} for malformed JSON rather than throwing', () => {
    fs.writeFileSync(file, '{not valid json');
    const store = createSettingsStore(file);
    expect(store.load()).toEqual({});
  });

  it('rejects arrays at the top level', () => {
    fs.writeFileSync(file, JSON.stringify(['foo', 'bar']));
    const store = createSettingsStore(file);
    expect(store.load()).toEqual({});
  });

  it('rejects null at the top level', () => {
    fs.writeFileSync(file, 'null');
    const store = createSettingsStore(file);
    expect(store.load()).toEqual({});
  });

  it('save() merges with the existing settings and persists to disk', () => {
    fs.writeFileSync(file, JSON.stringify({ calibreBinDir: '/old' }));
    const store = createSettingsStore(file);
    const result = store.save({ themePref: 'slate' });
    expect(result).toEqual({ calibreBinDir: '/old', themePref: 'slate' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')))
      .toEqual({ calibreBinDir: '/old', themePref: 'slate' });
  });

  it('save() drops keys whose value is null (forget)', () => {
    fs.writeFileSync(file, JSON.stringify({ calibreBinDir: '/old', themePref: 'slate' }));
    const store = createSettingsStore(file);
    const result = store.save({ calibreBinDir: null });
    expect(result).toEqual({ themePref: 'slate' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')))
      .toEqual({ themePref: 'slate' });
  });

  it('save() drops keys whose value is undefined', () => {
    const store = createSettingsStore(file);
    store.save({ a: 1 });
    const result = store.save({ a: undefined });
    expect(result).toEqual({});
  });

  it('subsequent load() returns the saved value (cache stays in sync)', () => {
    const store = createSettingsStore(file);
    store.save({ calibreBinDir: '/opt/calibre' });
    expect(store.load()).toEqual({ calibreBinDir: '/opt/calibre' });
  });

  it('save() writes atomically via .tmp + rename', () => {
    const store = createSettingsStore(file);
    store.save({ a: 1 });
    // After save() returns, the .tmp file should not exist — rename moves it.
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('save() with no bound file path still updates the cache but skips disk', () => {
    const store = createSettingsStore(null);
    const result = store.save({ a: 1 });
    expect(result).toEqual({ a: 1 });
    expect(store.load()).toEqual({ a: 1 });
  });

  it('two stores against the same path are independent caches', () => {
    const a = createSettingsStore(file);
    const b = createSettingsStore(file);
    a.save({ x: 1 });
    // b's cache hasn't been hydrated yet, so a fresh load() reads the
    // freshly-written file.
    expect(b.load()).toEqual({ x: 1 });
    // After both have loaded, mutating a's cache doesn't affect b's
    // (they're separate object references).
    a.save({ x: 2 });
    expect(b.load().x).toBe(1);
  });
});
