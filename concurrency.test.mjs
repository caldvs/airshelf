import { describe, it, expect } from 'vitest';
import { mapWithConcurrency, createSerialQueue } from './concurrency.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => x * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const items = [10, 10, 10, 10, 10, 10];
    await mapWithConcurrency(items, 2, async (ms) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(ms);
      active--;
    });
    expect(peak).toBe(2);
  });

  it('handles fewer items than limit without spawning idle workers', async () => {
    let starts = 0;
    await mapWithConcurrency([1, 2], 5, async () => { starts++; });
    expect(starts).toBe(2);
  });

  it('handles empty input', async () => {
    const out = await mapWithConcurrency([], 4, async () => 'never');
    expect(out).toEqual([]);
  });

  it('propagates errors from the mapper (Promise.all semantics)', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error('boom');
      return x;
    })).rejects.toThrow('boom');
  });

  it('treats limit < 1 as 1 (no division by zero, no infinite spawn)', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (x) => x);
    expect(out).toEqual([1, 2, 3]);
  });
});

describe('createSerialQueue', () => {
  it('runs tasks sequentially even when they are submitted at once', async () => {
    const queue = createSerialQueue();
    const order = [];
    const tasks = [50, 10, 30].map((ms, i) =>
      queue(async () => {
        await sleep(ms);
        order.push(i);
      })
    );
    await Promise.all(tasks);
    // Despite the middle task being fastest, FIFO order is preserved.
    expect(order).toEqual([0, 1, 2]);
  });

  it('returns the task result to the caller', async () => {
    const queue = createSerialQueue();
    const result = await queue(async () => 42);
    expect(result).toBe(42);
  });

  it('propagates rejections to the caller', async () => {
    const queue = createSerialQueue();
    await expect(queue(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
  });

  it('keeps processing later tasks even after a rejection', async () => {
    const queue = createSerialQueue();
    const errors = [];
    const results = [];
    const t1 = queue(async () => { throw new Error('first'); }).catch((e) => errors.push(e.message));
    const t2 = queue(async () => { results.push('second'); return 'second'; });
    const t3 = queue(async () => { results.push('third'); return 'third'; });
    await Promise.all([t1, t2, t3]);
    expect(errors).toEqual(['first']);
    expect(results).toEqual(['second', 'third']);
  });
});
