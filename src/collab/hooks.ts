export interface CollabHooks {
  onMembershipChanged(projectId: string, userId: string): void | Promise<void>;
  onUserRoleChanged(userId: string): void | Promise<void>;
  onSessionsChanged?(userId: string): void | Promise<void>;
  onProjectRenamed(projectId: string, name: string): void;
  onProjectDeleted(projectId: string): void;
}

/**
 * Runs a hook after its change is committed. A failing hook is logged, not thrown: the change
 * already happened, so the request must not answer as if it had failed.
 */
export async function notifyRooms(call: () => void | Promise<void>): Promise<void> {
  try {
    await call();
  } catch (err) {
    console.error('Collaboration hook failed:', err);
  }
}
