import type { RunInBackground } from '../../src/http/background';

/** Collects background tasks so a test can wait for them and see their errors. */
export class BackgroundTasks {
  private pending: Promise<void>[] = [];
  private errors: unknown[] = [];

  readonly run: RunInBackground = (task) => {
    this.pending.push(task().catch((err) => void this.errors.push(err)));
  };

  async settle(): Promise<void> {
    while (this.pending.length > 0) {
      await Promise.all(this.pending.splice(0));
    }
    if (this.errors.length > 0) throw this.errors[0];
  }
}
