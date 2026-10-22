import type { AppConfig } from '../config';
import type { PrismaClient } from '../db/prisma';
import type { Mailer } from '../mail/mailer';
import { templates, type Template } from '../mail/templates';
import { acceptPendingInvitations } from '../projects/invitations';
import { isAllowedDomain, normalizeEmail } from './domain';
import { consumeEmailToken, issueEmailToken } from './email-tokens';
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from './passwords';
import { toPublicUser, type PublicUser } from './public-user';
import { createSession, destroyOtherSessions, destroySession } from './sessions';

export type AuthServiceDeps = {
  prisma: PrismaClient;
  mailer: Mailer;
  config: Pick<AppConfig, 'appUrl' | 'allowedDomains' | 'admin'>;
};

export type Registration = { email: string; name: string; password: string };
export type SignedIn = { user: PublicUser; sessionToken: string };

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * Same outcome whether or not the account exists, so it cannot be used to probe accounts;
   * the mail tells the owner what happened.
   */
  async register(input: Registration): Promise<'verification_sent' | 'registration_not_allowed'> {
    const email = normalizeEmail(input.email);
    if (!this.canRegister(email)) return 'registration_not_allowed';

    // Hash before the lookup so every branch costs the same.
    const passwordHash = await hashPassword(input.password);
    const { prisma } = this.deps;
    const existing = await prisma.user.findUnique({ where: { email } });

    if (existing?.emailVerifiedAt) {
      await this.mail(
        email,
        templates.alreadyRegistered(this.link('/login'), this.link('/forgot')),
      );
      return 'verification_sent';
    }

    const token = await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email },
        create: { email, name: input.name, passwordHash },
        update: { name: input.name, passwordHash },
      });
      return issueEmailToken(tx, user.id, 'verify');
    });
    await this.mail(email, templates.verifyEmail(this.tokenLink('/verify', token), input.name));
    return 'verification_sent';
  }

  async verify(token: string): Promise<SignedIn | null> {
    const user = await this.deps.prisma.$transaction(async (tx) => {
      const userId = await consumeEmailToken(tx, token, 'verify');
      if (!userId) return null;
      const verified = await tx.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      });
      await acceptPendingInvitations(tx, verified.id, verified.email);
      return verified;
    });
    return user ? this.signIn(toPublicUser(user)) : null;
  }

  async resendVerification(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const { prisma } = this.deps;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return;
    const token = await prisma.$transaction((tx) => issueEmailToken(tx, user.id, 'verify'));
    await this.mail(email, templates.verifyEmail(this.tokenLink('/verify', token), user.name));
  }

  /** Unknown, unverified and wrong-password logins are indistinguishable. */
  async login(rawEmail: string, password: string): Promise<SignedIn | null> {
    const email = normalizeEmail(rawEmail);
    const user = await this.deps.prisma.user.findUnique({ where: { email } });
    const passwordOk = await verifyPasswordOrDummy(user?.passwordHash, password);
    if (!user || !passwordOk || !user.emailVerifiedAt) return null;
    return this.signIn(toPublicUser(user));
  }

  logout(sessionToken: string): Promise<void> {
    return destroySession(this.deps.prisma, sessionToken);
  }

  /** Only verified accounts get a reset link; the caller answers the same either way. */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const { prisma } = this.deps;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.emailVerifiedAt) return;
    const token = await prisma.$transaction((tx) => issueEmailToken(tx, user.id, 'reset'));
    await this.mail(email, templates.resetPassword(this.tokenLink('/reset', token)));
  }

  /** Sets the new password and signs the user out everywhere. */
  async resetPassword(token: string, password: string): Promise<boolean> {
    const passwordHash = await hashPassword(password);
    return this.deps.prisma.$transaction(async (tx) => {
      const userId = await consumeEmailToken(tx, token, 'reset');
      if (!userId) return false;
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId } });
      return true;
    });
  }

  /** Keeps the current session and signs the user out of every other one. */
  async changePassword(
    userId: string,
    sessionToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const { prisma } = this.deps;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) return false;
    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await destroyOtherSessions(prisma, userId, sessionToken);
    return true;
  }

  private canRegister(email: string): boolean {
    const { allowedDomains, admin } = this.deps.config;
    return email === admin.email || isAllowedDomain(email, allowedDomains);
  }

  private async signIn(user: PublicUser): Promise<SignedIn> {
    return { user, sessionToken: await createSession(this.deps.prisma, user.id) };
  }

  private link(path: string): string {
    return `${this.deps.config.appUrl}${path}`;
  }

  private tokenLink(path: string, token: string): string {
    return `${this.link(path)}?token=${token}`;
  }

  private mail(to: string, template: Template): Promise<void> {
    return this.deps.mailer.send({ to, ...template });
  }
}
