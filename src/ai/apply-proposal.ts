import { toPublicUser } from '../auth/public-user';
import type { Document, Op } from '../collab/ops';
import type { PrismaClient } from '../db/prisma';
import type { Prisma } from '../generated/prisma/client';
import { AppError } from '../http/app-error';
import { getRole } from '../projects/repo';
import { hashDocument } from './document-index';
import type { CommitProposalInput, CommitProposalResult } from './project-source';
import { prepareProposal } from './proposal-validation';


export type ExecuteCommitProposalOutcome =
  | {
      alreadyApplied: true;
      result: CommitProposalResult;
    }
  | {
      alreadyApplied: false;
      result: CommitProposalResult;
      afterDoc: Document;
      ops: Op[];
      nextVersion: number;
    };

export async function executeCommitProposal(params: {
  prisma: PrismaClient;
  input: CommitProposalInput;
  currentDoc: Document;
  currentVersion: number;
  now?: Date;
}): Promise<ExecuteCommitProposalOutcome> {
  const { prisma, input, currentDoc, currentVersion } = params;
  const now = params.now ?? new Date();
  const { projectId, proposalId, revision, user } = input;

  // Pre-check expiry outside the main mutation transaction so expired status persists even when throwing 409
  const preCheck = await prisma.aiProposal.findFirst({
    where: { id: proposalId, projectId, userId: user.id },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!preCheck) {
    throw new AppError('not_found');
  }
  if (preCheck.status === 'pending' && preCheck.expiresAt.getTime() <= now.getTime()) {
    await prisma.aiProposal.updateMany({
      where: { id: proposalId, status: 'pending' },
      data: { status: 'expired' },
    });
    throw new AppError('ai_expired_proposal');
  }

  return prisma.$transaction(async (tx): Promise<ExecuteCommitProposalOutcome> => {
    // Lock the project row and user row to serialize with any concurrent DB writer or permission revocation
    const lockedProjects = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE
    `;
    if (lockedProjects.length === 0) {
      throw new AppError('not_found');
    }

    const lockedUsers = await tx.$queryRaw<
      Array<{
        id: string;
        email: string;
        name: string;
        password_hash: string;
        is_admin: boolean;
        is_superadmin: boolean;
        email_verified_at: Date | null;
        created_at: Date;
      }>
    >`
      SELECT id, email, name, password_hash, is_admin, is_superadmin, email_verified_at, created_at
      FROM users
      WHERE id = ${user.id}::uuid
      FOR UPDATE
    `;
    const dbUser = lockedUsers[0];
    if (!dbUser || !dbUser.email_verified_at) {
      throw new AppError('not_found');
    }

    const currentUser = toPublicUser({
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      passwordHash: dbUser.password_hash,
      isAdmin: dbUser.is_admin,
      isSuperadmin: dbUser.is_superadmin,
      emailVerifiedAt: dbUser.email_verified_at,
      createdAt: dbUser.created_at,
    });

    if (!currentUser.isAdmin) {
      await tx.$queryRaw<Array<{ role: string }>>`
        SELECT role FROM project_members
        WHERE project_id = ${projectId}::uuid AND user_id = ${currentUser.id}::uuid
        FOR UPDATE
      `;
    }

    const role = await getRole(tx, projectId, currentUser);
    if (!role) {
      throw new AppError('not_found');
    }
    if (role === 'viewer') {
      throw new AppError('forbidden');
    }


    const proposal = await tx.aiProposal.findFirst({
      where: { id: proposalId, projectId, userId: user.id },
    });
    if (!proposal) {
      throw new AppError('not_found');
    }

    // Idempotent repeat of an already-applied proposal revision
    if (proposal.status === 'applied' && proposal.revision === revision) {
      if (
        proposal.appliedResult &&
        typeof proposal.appliedResult === 'object' &&
        !Array.isArray(proposal.appliedResult)
      ) {
        const stored = proposal.appliedResult as unknown as CommitProposalResult;
        return {
          alreadyApplied: true,
          result: {
            proposalId: stored.proposalId ?? proposal.id,
            revision: stored.revision ?? proposal.revision,
            version: stored.version ?? Number(proposal.appliedVersion ?? currentVersion),
            snapshotId: stored.snapshotId ?? proposal.snapshotId ?? null,
            applied: true,
          },
        };
      }
      return {
        alreadyApplied: true,
        result: {
          proposalId: proposal.id,
          revision: proposal.revision,
          version: Number(proposal.appliedVersion ?? currentVersion),
          snapshotId: proposal.snapshotId,
          applied: true,
        },
      };
    }

    if (proposal.status === 'expired' || proposal.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('ai_expired_proposal');
    }

    if (proposal.revision !== revision || proposal.status !== 'pending') {
      throw new AppError('ai_stale_proposal');
    }

    const currentHash = hashDocument(currentDoc);
    if (Number(proposal.baseVersion) !== currentVersion || proposal.baseHash !== currentHash) {
      throw new AppError('ai_stale_proposal');
    }

    // Revalidate all operations and full resulting document on a copy of currentDoc
    const prepared = prepareProposal(
      currentDoc,
      { ops: proposal.ops, warnings: proposal.warnings },
      { entities: null },
    );

    const prevDiagram = currentDoc as Prisma.InputJsonValue;
    const prevSizeBytes = Buffer.byteLength(JSON.stringify(prevDiagram));

    const snapshot = await tx.projectSnapshot.create({
      data: {
        projectId,
        diagram: prevDiagram,
        version: BigInt(currentVersion),
        kind: 'pre_ai_apply',
        createdBy: user.id,
        authors: [{ id: user.id, name: user.name }],
        sizeBytes: prevSizeBytes,
      },
      select: { id: true },
    });

    const nextVersion = currentVersion + 1;
    const nextDiagram = prepared.after as Prisma.InputJsonValue;

    const { count } = await tx.project.updateMany({
      where: { id: projectId },
      data: {
        diagram: nextDiagram,
        version: BigInt(nextVersion),
        updatedAt: now,
      },
    });
    if (count === 0) {
      throw new AppError('not_found');
    }

    const appliedResult: CommitProposalResult = {
      proposalId: proposal.id,
      revision: proposal.revision,
      version: nextVersion,
      snapshotId: snapshot.id,
      applied: true,
    };

    await tx.aiProposal.update({
      where: { id: proposal.id },
      data: {
        status: 'applied',
        appliedVersion: BigInt(nextVersion),
        snapshotId: snapshot.id,
        appliedResult: appliedResult as unknown as Prisma.InputJsonValue,
        updatedAt: now,
      },
    });

    return {
      alreadyApplied: false,
      result: appliedResult,
      afterDoc: prepared.after,
      ops: prepared.ops,
      nextVersion,
    };
  });
}
