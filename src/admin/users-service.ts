import { notifyRooms, type CollabHooks } from '../collab/hooks';
import type { PrismaClient } from '../db/prisma';
import { AppError } from '../http/app-error';

export type AdminUserView = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  isSuperadmin: boolean;
  verified: boolean;
  createdAt: Date;
};

const userFields = {
  id: true,
  email: true,
  name: true,
  isAdmin: true,
  isSuperadmin: true,
  emailVerifiedAt: true,
  createdAt: true,
} as const;

type UserRow = Omit<AdminUserView, 'verified'> & { emailVerifiedAt: Date | null };

function toView({ emailVerifiedAt, ...user }: UserRow): AdminUserView {
  return { ...user, verified: emailVerifiedAt !== null };
}

/** User administration: listing accounts and granting or revoking the administrator role. */
export class AdminUsersService {
  constructor(private readonly deps: { prisma: PrismaClient; rooms?: CollabHooks }) {}

  async list(): Promise<AdminUserView[]> {
    const users = await this.deps.prisma.user.findMany({
      select: userFields,
      orderBy: { createdAt: 'asc' },
    });
    return users.map(toView);
  }

  /**
   * The superadmin's role cannot change, and the last administrator cannot be demoted. The
   * administrators' rows are locked first, so concurrent demotions are checked one after
   * another and cannot leave the system without administrators.
   */
  async setAdmin(id: string, isAdmin: boolean): Promise<AdminUserView> {
    const user = await this.deps.prisma.$transaction(async (tx) => {
      const admins = await tx.$queryRaw<{ id: string }[]>`
        select id from users where is_admin and email_verified_at is not null for update`;
      const target = await tx.user.findUnique({
        where: { id },
        select: { isSuperadmin: true, emailVerifiedAt: true },
      });
      if (!target) throw new AppError('not_found');
      if (target.isSuperadmin) throw new AppError('cannot_change_superadmin');
      if (isAdmin && !target.emailVerifiedAt) throw new AppError(400, 'user_not_verified');
      const isOnlyAdmin = admins.length === 1 && admins[0].id === id;
      if (!isAdmin && isOnlyAdmin) throw new AppError('last_admin');
      return tx.user.update({ where: { id }, data: { isAdmin }, select: userFields });
    });
    await notifyRooms(() => this.deps.rooms?.onUserRoleChanged(id));
    return toView(user);
  }
}
