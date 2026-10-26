/**
 * Per-project FIFO async queue used to serialize all competing mutations,
 * restorations, AI proposal confirmations, and persistence flushes.
 */
export class ProjectQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(projectId) ?? Promise.resolve();
    const next = prev.then(() => work());
    const tracked = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.tails.get(projectId) === tracked) {
          this.tails.delete(projectId);
        }
      });
    this.tails.set(projectId, tracked);
    return next;
  }

  async drainAll(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.allSettled([...this.tails.values()]);
    }
  }
}

