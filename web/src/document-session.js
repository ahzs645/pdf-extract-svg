/** Owns the resources and asynchronous work for one loaded PDF. */
export class DocumentSession {
  constructor(bytes, { createLoadingTask, loadMu = () => import('mupdf') }) {
    // PDF.js transfers its input; keep a separate copy for MuPDF.
    this.bytes = new Uint8Array(bytes).slice();
    this.loadMu = loadMu;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.pdfDoc = null;
    this.muDoc = null;
    this.muPromise = null;
    this.muDocPromise = null;
    this.renderTasks = new Set();
    this.caches = {
      images: new Map(), svg: new Map(), fonts: new Map(), objects: new Map(),
    };
    const resources = createLoadingTask(this.bytes.slice());
    this.loadingTask = resources.loadingTask;
    this.disposeWorker = resources.disposeWorker;
    this.readyPromise = this.loadingTask.promise.then((doc) => {
      this.assertActive();
      this.pdfDoc = doc;
      return doc;
    });
    // A superseded load may be disposed before a caller awaits it.
    this.readyPromise.catch(() => {});
  }

  assertActive() {
    this.signal.throwIfAborted();
  }

  async ready() {
    const doc = await this.readyPromise;
    this.assertActive();
    return doc;
  }

  async getPage(number) {
    const doc = await this.ready();
    const page = await doc.getPage(number);
    this.assertActive();
    return page;
  }

  async render(page, options) {
    this.assertActive();
    const task = page.render(options);
    this.renderTasks.add(task);
    try {
      await task.promise;
      this.assertActive();
    } finally {
      this.renderTasks.delete(task);
    }
  }

  async getMu() {
    this.assertActive();
    this.muPromise ||= this.loadMu();
    const mu = await this.muPromise;
    this.assertActive();
    return mu;
  }

  async getMuDoc() {
    this.assertActive();
    this.muDocPromise ||= (async () => {
      const mu = await this.getMu();
      this.assertActive();
      this.muDoc = mu.Document.openDocument(this.bytes, 'application/pdf');
      return this.muDoc;
    })();
    const doc = await this.muDocPromise;
    this.assertActive();
    return doc;
  }

  /** Safe to call repeatedly, including while PDF.js or MuPDF is loading. */
  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.controller.abort();
    for (const task of this.renderTasks) task.cancel();
    for (const cache of Object.values(this.caches)) cache.clear();
    this.disposePromise = (async () => {
      try {
        await this.loadingTask.destroy();
      } finally {
        this.disposeWorker?.();
        // An import still in flight will observe the aborted signal before
        // opening a document. An already opened document needs explicit free.
        this.muDoc?.destroy();
        this.muDoc = null;
        this.muDocPromise = null;
        this.muPromise = null;
        this.pdfDoc = null;
        this.bytes = null;
      }
    })();
    return this.disposePromise;
  }
}

export function isCancelled(error, session) {
  return session?.signal.aborted || error?.name === 'AbortError' ||
    error?.name === 'RenderingCancelledException';
}
