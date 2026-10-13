import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewStore } from '../src/preview-store.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const result = (text) => ({
  blob: new Blob([text]),
  format: 'svg',
  svgString: text,
});
function harness(build) {
  const selection = { x: 1, deletedIds: ['a'] };
  const active = new Set([selection]),
    created = [],
    revoked = [];
  const store = new PreviewStore({
    build,
    isActive: (s) => active.has(s),
    onChange() {},
    urls: {
      createObjectURL(blob) {
        const url = `blob:${created.length}`;
        created.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
  });
  return { selection, active, created, revoked, store };
}

test('out-of-order exports keep the latest preview and download together', async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const h = harness(() => (++calls === 1 ? first : second).promise);
  const old = h.store.buildPreview(h.selection);
  await Promise.resolve();
  const latest = h.store.buildPreview(h.selection);
  await Promise.resolve();
  second.resolve(result('latest'));
  await latest;
  first.resolve(result('obsolete'));
  await old;
  assert.equal(await h.selection.blob.text(), 'latest');
  assert.equal(h.selection.svgString, 'latest');
  assert.equal(h.selection.previewState, 'ready');
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].blob, h.selection.blob);
});

test('downloads join a pending rebuild instead of using an old blob', async () => {
  const next = deferred();
  let calls = 0;
  const h = harness(() => {
    calls++;
    return next.promise;
  });
  h.selection.blob = new Blob(['old']);
  h.selection.previewState = 'ready';
  const build = h.store.buildPreview(h.selection);
  assert.equal(h.selection.blob, undefined);
  const download = h.store.ensureReady(h.selection);
  await Promise.resolve();
  next.resolve(result('new'));
  await build;
  assert.equal(await (await download).text(), 'new');
  assert.equal(calls, 1);
});

test('removing a selection while exporting cannot create a leaked preview URL', async () => {
  const next = deferred(),
    h = harness(() => next.promise);
  const job = h.store.buildPreview(h.selection);
  await Promise.resolve();
  h.active.delete(h.selection);
  h.store.remove(h.selection);
  next.resolve(result('removed'));
  await job;
  assert.equal(h.created.length, 0);
  assert.equal(h.selection.blob, undefined);
  await assert.rejects(h.store.ensureReady(h.selection), {
    name: 'AbortError',
  });
});

test('a stale failure cannot replace a newer successful export', async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const h = harness(() => (++calls === 1 ? first : second).promise);
  const old = h.store.buildPreview(h.selection);
  await Promise.resolve();
  const latest = h.store.buildPreview(h.selection);
  await Promise.resolve();
  second.resolve(result('latest'));
  await latest;
  first.reject(new Error('old failure'));
  await old;
  assert.equal(h.selection.previewState, 'ready');
  assert.equal(h.selection.previewError, null);
});

test('synchronous failures settle and failed exports reject downloads', async () => {
  const h = harness(() => {
    throw new Error('encode failed');
  });
  await h.store.buildPreview(h.selection);
  assert.equal(h.store.jobs.size, 0);
  await assert.rejects(h.store.ensureReady(h.selection), /encode failed/);
});

test('an export uses the selection snapshot and revokes its previous URL', async () => {
  let seen;
  const h = harness(async (s) => {
    seen = s;
    return result('snapshot');
  });
  h.selection.previewUrl = 'blob:old';
  const job = h.store.buildPreview(h.selection);
  h.selection.x = 10;
  h.selection.deletedIds.push('b');
  await job;
  assert.equal(seen.x, 1);
  assert.deepEqual(seen.deletedIds, ['a']);
  assert.deepEqual(h.revoked, ['blob:old']);
  h.store.remove(h.selection);
  assert.deepEqual(h.revoked, ['blob:old', 'blob:0']);
});

test('waiting downloads follow a superseding build', async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const h = harness(() => (++calls === 1 ? first : second).promise);
  const older = h.store.buildPreview(h.selection);
  await Promise.resolve();
  const download = h.store.ensureReady(h.selection);
  const latest = h.store.buildPreview(h.selection);
  await Promise.resolve();
  first.resolve(result('old'));
  await older;
  second.resolve(result('new'));
  await latest;
  assert.equal(await (await download).text(), 'new');
});
