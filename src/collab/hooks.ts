export interface CollabHooks {
  onMembershipChanged(projectId: string, userId: string): void | Promise<void>;
  onProjectRenamed(projectId: string, name: string): void;
  onProjectDeleted(projectId: string): void;
}
