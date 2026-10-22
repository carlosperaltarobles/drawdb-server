import type { PublicUser } from '../auth/public-user';
import type { Prisma, ProjectRole } from '../generated/prisma/client';

export type AccessRole = 'admin' | ProjectRole;

/**
 * The user's role in the project, or null when it does not exist or they have no access.
 * Administrators get 'admin' on every project.
 */
export async function getRole(
  db: Prisma.TransactionClient,
  projectId: string,
  user: PublicUser,
): Promise<AccessRole | null> {
  if (user.isAdmin) {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
    return project ? 'admin' : null;
  }
  const member = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { role: true },
  });
  return member?.role ?? null;
}
