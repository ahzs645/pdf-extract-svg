import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentSession } from '../src/document-session.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function harness({ loading, loadMu } = {}) {
  const calls = [];
  let workerInput;
  const doc = { getPage: async (n) => ({ number: n }) };
  const task = {
    promise: loading?.promise || Promise.resolve(doc),
    destroy: async () => {
      calls.push('pdf');
      loading?.reject(new DOMException('cancelled', 'AbortError'));
    },
  };
  const session = new DocumentSession(new Uint8Array([1, 2, 3]), {
    createLoadingTask: (bytes) => {
      workerInput = bytes;
      return { loadingTask: task, disposeWorker: () => calls.push('worker') };
    },
    loadMu:
      loadMu ||
      (async () => ({
        Document: {
          openDocument: (bytes) => {
            calls.push('openMu');
            return { destroy: () => calls.push('mu') };
          },
        },
      })),
  });
  return { session, doc, calls, workerInput };
}

test('PDF.js input and retained MuPDF bytes have separate storage', async () => {
  const h = harness();
  h.workerInput[0] = 99;
  assert.deepEqual([...h.session.bytes], [1, 2, 3]);
  assert.equal((await h.session.getPage(2)).number, 2);
  await h.session.dispose();
});

test('disposal clears caches and destroys both engines and worker exactly once', async () => {
  const h = harness();
  await h.session.ready();
  await h.session.getMuDoc();
  for (const cache of Object.values(h.session.caches)) cache.set(1, 'cached');
  const a = h.session.dispose(),
    b = h.session.dispose();
  assert.equal(a, b);
  await a;
  assert.deepEqual(h.calls, ['openMu', 'pdf', 'worker', 'mu']);
  assert.ok(Object.values(h.session.caches).every((c) => c.size === 0));
  assert.equal(h.session.bytes, null);
  assert.equal(h.session.pdfDoc, null);
  await assert.rejects(h.session.getPage(1), { name: 'AbortError' });
});

test('disposing during PDF loading cannot publish a late document', async () => {
  const loading = deferred(),
    h = harness({ loading });
  await h.session.dispose();
  await assert.rejects(h.session.ready(), { name: 'AbortError' });
  assert.deepEqual(h.calls, ['pdf', 'worker']);
  assert.equal(h.session.pdfDoc, null);
});

test('disposing during lazy MuPDF import does not open an obsolete document', async () => {
  const importing = deferred(),
    h = harness({ loadMu: () => importing.promise });
  const opening = h.session.getMuDoc();
  await Promise.resolve();
  // Cleanup must not wait for an uncancellable dynamic import to finish.
  await h.session.dispose();
  importing.resolve({
    Document: {
      openDocument: () => {
        throw Error('must not open');
      },
    },
  });
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(h.session.muDoc, null);
  assert.deepEqual(h.calls, ['pdf', 'worker']);
});

test('switching documents cancels tracked renders and releases them', async () => {
  const rendering = deferred(),
    h = harness();
  let cancelled = 0;
  const page = {
    render: () => ({
      promise: rendering.promise,
      cancel: () => {
        cancelled++;
        rendering.reject(new DOMException('render cancelled', 'AbortError'));
      },
    }),
  };
  const job = h.session.render(page, {});
  assert.equal(h.session.renderTasks.size, 1);
  const disposal = h.session.dispose();
  await assert.rejects(job, { name: 'AbortError' });
  await disposal;
  assert.equal(cancelled, 1);
  assert.equal(h.session.renderTasks.size, 0);
});

test('a late page lookup is rejected after disposal', async () => {
  const next = deferred(),
    h = harness();
  h.doc.getPage = () => next.promise;
  const lookup = h.session.getPage(1);
  await Promise.resolve();
  await Promise.resolve();
  await h.session.dispose();
  next.resolve({ number: 1 });
  await assert.rejects(lookup, { name: 'AbortError' });
});
