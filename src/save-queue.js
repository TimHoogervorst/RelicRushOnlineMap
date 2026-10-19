/** Serializes generation work. At most one pending autosave is retained. */
export class SaveQueue {
  #active = false;
  #pending = null;
  #latestRequested = 0;
  status = { state: 'saved', revision: 0, progress: null, error: null };

  reset() {
    if (this.#active || this.#pending) throw new Error('Wait for the active save before resetting the project.');
    this.#latestRequested = 0;
    this.status = { state: 'saved', revision: 0, progress: null, error: null };
  }

  enqueue(revision, run) {
    if (!Number.isSafeInteger(revision) || revision < 1 || typeof run !== 'function') throw new TypeError('A save needs a positive revision and a job');
    if (revision < this.#latestRequested) return Promise.reject(new Error('Stale revision; reload and retry your edit.'));
    this.#latestRequested = revision;
    this.status = { state: 'unsaved', revision, progress: null, error: null };
    return new Promise((resolve, reject) => {
      if (this.#pending) this.#pending.reject(new Error('Save coalesced by a newer revision.'));
      this.#pending = { revision, run, resolve, reject };
      void this.#drain();
    });
  }

  async #drain() {
    if (this.#active) return;
    this.#active = true;
    try {
      while (this.#pending) {
        const job = this.#pending;
        this.#pending = null;
        if (job.revision < this.#latestRequested) {
          job.reject(new Error('Save coalesced by a newer revision.'));
          continue;
        }
        this.status = { state: 'saving', revision: job.revision, progress: { phase: 'starting', percent: 0 }, error: null };
        try {
          const result = await job.run({
            isLatest: () => job.revision === this.#latestRequested,
            progress: (phase, percent) => {
              if (job.revision === this.#latestRequested) this.status = { state: 'saving', revision: job.revision, progress: { phase, percent: Math.max(0, Math.min(100, percent)) }, error: null };
            }
          });
          if (!job.revision || job.revision < this.#latestRequested) throw new Error('Save superseded by a newer revision.');
          this.status = { state: 'saved', revision: job.revision, progress: { phase: 'complete', percent: 100 }, error: null };
          job.resolve(result);
        } catch (error) {
          if (job.revision === this.#latestRequested) this.status = { state: 'failed', revision: job.revision, progress: null, error: error.message };
          job.reject(error);
        }
      }
    } finally { this.#active = false; }
  }
}
