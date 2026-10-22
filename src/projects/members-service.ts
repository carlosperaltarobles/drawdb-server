import { isAllowedDomain, normalizeEmail } from '../auth/domain';
import type { PublicUser } from '../auth/public-user';
import { newToken } from '../auth/tokens';
import { notifyRooms, type CollabHooks } from '../collab/hooks';
import type { AppConfig } from '../config';
import type { PrismaClient } from '../db/prisma';
import type { ProjectRole } from '../generated/prisma/client';
import { AppError } from '../http/app-error';
import type { RunInBackground } from '../http/background';
import type { Mailer } from '../mail/mailer';
import { templates, type Template } from '../mail/templates';
import type { ProjectRef } from './service';

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type MembersServiceDeps = {
  prisma: PrismaClient;
  mailer: Mailer;
  config: Pick<AppConfig, 'appUrl' | 'allowedDomains'>;
  runInBackground: RunInBackground;
  rooms?: CollabHooks;
};

export type MemberList = {
  members: { userId: string; email: string; name: string; role: ProjectRole }[];
  invitations: { id: string; email: string; role: ProjectRole; expiresAt: Date }[];
};

/** Who belongs to a project, and the invitations that will add people once they verify. */
export class MembersService {
  constructor(private readonly deps: MembersServiceDeps) {}

  /** Open (not yet accepted) invitations are listed even when expired, so they can be removed. */
  async list(projectId: string): Promise<MemberList> {
    const { prisma } = this.deps;
    await this.findProject(projectId);
    const [members, invitations] = await Promise.all([
      prisma.projectMember.findMany({
        where: { projectId },
        select: { userId: true, role: true, user: { select: { email: true, name: true } } },
        orderBy: { user: { email: 'asc' } },
      }),
      prisma.projectInvitation.findMany({
        where: { projectId, acceptedAt: null },
        select: { id: true, email: true, role: true, expiresAt: true },
        orderBy: { email: 'asc' },
      }),
    ]);
    return {
      members: members.map(({ userId, role, user }) => ({ userId, role, ...user })),
      invitations,
    };
  }

  /**
   * A verified account becomes a member at once, whatever its domain. Anyone else gets an
   * invitation (only for an allowed domain, since they still have to register) that turns into
   * a membership when they verify their email.
   */
  async add(
    projectId: string,
    rawEmail: string,
    role: ProjectRole,
    inviter: PublicUser,
  ): Promise<'added' | 'invited'> {
    const email = normalizeEmail(rawEmail);
    const project = await this.findProject(projectId);
    const user = await this.deps.prisma.user.findUnique({
      where: { email },
      select: { id: true, emailVerifiedAt: true },
    });
    if (user?.emailVerifiedAt) {
      await this.addVerifiedUser(project, user.id, email, role);
      return 'added';
    }
    if (!isAllowedDomain(email, this.deps.config.allowedDomains)) {
      throw new AppError('registration_not_allowed');
    }
    await this.invite(project, email, role, inviter);
    return 'invited';
  }

  async changeRole(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    const { count } = await this.deps.prisma.projectMember.updateMany({
      where: { projectId, userId },
      data: { role },
    });
    if (count === 0) throw new AppError('not_found');
    await this.membershipChanged(projectId, userId);
  }

  async remove(projectId: string, userId: string): Promise<void> {
    const { count } = await this.deps.prisma.projectMember.deleteMany({
      where: { projectId, userId },
    });
    if (count === 0) throw new AppError('not_found');
    await this.membershipChanged(projectId, userId);
  }

  async cancelInvitation(projectId: string, invitationId: string): Promise<void> {
    const { count } = await this.deps.prisma.projectInvitation.deleteMany({
      where: { id: invitationId, projectId, acceptedAt: null },
    });
    if (count === 0) throw new AppError('not_found');
  }

  private async findProject(id: string): Promise<ProjectRef> {
    const project = await this.deps.prisma.project.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!project) throw new AppError('not_found');
    return project;
  }

  private async addVerifiedUser(
    project: ProjectRef,
    userId: string,
    email: string,
    role: ProjectRole,
  ): Promise<void> {
    await this.deps.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId } },
      create: { projectId: project.id, userId, role },
      update: { role },
    });
    await this.membershipChanged(project.id, userId);
    const link = `${this.deps.config.appUrl}/projects/${project.id}`;
    this.mailInBackground(email, templates.addedToProject(link, project.name));
  }

  /**
   * Re-inviting renews the open invitation (role, token, expiry) instead of adding another.
   * The project row is locked first, so concurrent invitations for it run one after another
   * and cannot both create one.
   */
  private async invite(
    project: ProjectRef,
    email: string,
    role: ProjectRole,
    inviter: PublicUser,
  ): Promise<void> {
    const { prisma, config } = this.deps;
    const data = {
      role,
      tokenHash: newToken().hash,
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    };
    const invited = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<unknown[]>`
        select id from projects where id = ${project.id}::uuid for update`;
      if (locked.length === 0) return false;
      const open = await tx.projectInvitation.findFirst({
        where: { projectId: project.id, email, acceptedAt: null },
        select: { id: true },
      });
      if (open) {
        await tx.projectInvitation.update({ where: { id: open.id }, data });
      } else {
        await tx.projectInvitation.create({ data: { projectId: project.id, email, ...data } });
      }
      return true;
    });
    if (!invited) throw new AppError('not_found');
    const link = `${config.appUrl}/register?email=${encodeURIComponent(email)}`;
    this.mailInBackground(email, templates.projectInvite(link, project.name, inviter.name));
  }

  private membershipChanged(projectId: string, userId: string): Promise<void> {
    return notifyRooms(() => this.deps.rooms?.onMembershipChanged(projectId, userId));
  }

  private mailInBackground(to: string, template: Template): void {
    this.deps.runInBackground(() => this.deps.mailer.send({ to, ...template }));
  }
}
