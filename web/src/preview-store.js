/** Commits an export only when it still belongs to the latest selection build. */
export class PreviewStore {
  constructor({ build, isActive, onChange, urls = URL }) {
    Object.assign(this, { build, isActive, onChange, urls });
    this.jobs = new Map();
  }

  buildPreview(selection, build = this.build) {
    const token = (selection.previewToken || 0) + 1;
    selection.previewToken = token;
    selection.previewState = 'pending';
    selection.previewError = null;
    // Old exports must not remain downloadable while a new one is pending.
    delete selection.blob;
    const snapshot = {
      ...selection,
      objectIds: selection.objectIds?.slice(),
      hiddenIds: selection.hiddenIds?.slice(),
      deletedIds: selection.deletedIds?.slice(),
    };
    const current = () => selection.previewToken === token && this.isActive(selection);
    this.onChange();
    const job = Promise.resolve().then(async () => {
      try {
        if (!current()) return;
        const result = await build(snapshot);
        if (!current()) return;
        const url = this.urls.createObjectURL(result.blob);
        if (selection.previewUrl) this.urls.revokeObjectURL(selection.previewUrl);
        Object.assign(selection, result, {
          previewUrl: url, byteSize: result.blob.size, previewState: 'ready',
        });
      } catch (error) {
        if (!current()) return;
        selection.previewState = 'error';
        selection.previewError = error.message;
      } finally {
        if (current()) {
          this.jobs.delete(selection);
          this.onChange();
        }
      }
    });
    this.jobs.set(selection, job);
    return job;
  }

  /** Join an existing preview rather than launching a competing export. */
  async ensureReady(selection) {
    while (this.isActive(selection)) {
      const job = this.jobs.get(selection);
      if (job) await job;
      else if (selection.previewState === 'ready' && selection.blob) return selection.blob;
      else if (selection.previewState === 'error') throw new Error(selection.previewError);
      else await this.buildPreview(selection);
    }
    throw new DOMException('Selection was removed or its document changed', 'AbortError');
  }

  remove(selection) {
    selection.previewToken = (selection.previewToken || 0) + 1;
    this.jobs.delete(selection);
    if (selection.previewUrl) this.urls.revokeObjectURL(selection.previewUrl);
    delete selection.previewUrl;
    delete selection.blob;
  }
}
