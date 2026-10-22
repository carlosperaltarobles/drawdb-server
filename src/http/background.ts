/** Starts work the response does not wait for; implementations must never let it reject unhandled. */
export type RunInBackground = (task: () => Promise<void>) => void;

export const runDetached: RunInBackground = (task) => {
  task().catch((err) => console.error('Background task failed:', err));
};
