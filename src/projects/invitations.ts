import type { Prisma } from '../generated/prisma/client';

/**
 * Turns every open invitation for `email` into a membership (an existing membership is kept
 * as is) and marks the invitations accepted. Runs inside the caller's transaction.
 */
export async function acceptPendingInvitations(
  prisma: Prisma.TransactionClient,
  userId: string,
  email: string,
): Promise<void> {
  const now = new Date();
  const invitations = await prisma.projectInvitation.findMany({
    where: { email, acceptedAt: null, expiresAt: { gt: now } },
  });
  for (const invitation of invitations) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: invitation.projectId, userId } },
      create: { projectId: invitation.projectId, userId, role: invitation.role },
      update: {},
    });
  }
  await prisma.projectInvitation.updateMany({
    where: { id: { in: invitations.map((i) => i.id) } },
    data: { acceptedAt: now },
  });
}
