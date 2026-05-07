// Run `mapper(item, i)` over `items` with at most `limit` running at once.
// Workers cooperatively pull from a shared cursor, so a slow item doesn't
// stall the others. Errors propagate (Promise.all behaviour); a single
// failure aborts the batch.
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await mapper(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

// FIFO queue that runs at most one async task at a time. Used to make
// load-then-write blocks atomic across concurrent callers (e.g. concurrent
// addBooks both reading + writing books.json without losing each other's
// updates). Errors don't break the chain — the rejected promise is still
// returned to the caller, but later tasks proceed.
function createSerialQueue() {
  let tail = Promise.resolve();
  return function run(fn) {
    const next = tail.then(() => fn());
    tail = next.catch(() => {});
    return next;
  };
}

module.exports = { mapWithConcurrency, createSerialQueue };
