import type { AppConfig } from '../config';
import type { PrismaClient } from '../db/prisma';
import type { RunInBackground } from '../http/background';
import type { Mailer } from '../mail/mailer';
import { templates, type Template } from '../mail/templates';
import { acceptPendingInvitations } from '../projects/invitations';
import { isAllowedDomain, normalizeEmail } from './domain';
import { findValidEmailToken, issueEmailToken, markEmailTokenUsed } from './email-tokens';
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from './passwords';
import { toPublicUser, type PublicUser } from './public-user';
import { createSession, destroyOtherSessions, destroySession } from './sessions';

export type AuthServiceDeps = {
  prisma: PrismaClient;
  mailer: Mailer;
  config: Pick<AppConfig, 'appUrl' | 'allowedDomains'>;
  runInBackground: RunInBackground;
};

export type Registration = { email: string; name: string; password: string };
export type SignedIn = { user: PublicUser; sessionToken: string };

/**
 * register, resendVerification and requestPasswordReset do their database and mail work in
 * the background, so neither the answer nor its timing reveals whether the account exists.
 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  isRegistrationAllowed(email: string): boolean {
    return isAllowedDomain(email, this.deps.config.allowedDomains);
  }

  register(input: Registration): 'verification_sent' | 'registration_not_allowed' {
    if (!this.isRegistrationAllowed(input.email)) return 'registration_not_allowed';
    this.deps.runInBackground(() => this.completeRegistration(input));
    return 'verification_sent';
  }

  /**
   * Requires the account's password as well as the token, so whoever re-registered a pending
   * account with their own password cannot get it verified by the owner of the inbox.
   * A wrong password leaves the token usable.
   */
  async verify(token: string, password: string): Promise<SignedIn | null> {
    const { prisma } = this.deps;
    const found = await findValidEmailToken(prisma, token, 'verify');
    if (!found) return null;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: found.userId } });
    if (!(await verifyPassword(user.passwordHash, password))) return null;

    const verified = await prisma.$transaction(async (tx) => {
      if (!(await markEmailTokenUsed(tx, found.id))) return null;
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
      await acceptPendingInvitations(tx, updated.id, updated.email);
      return updated;
    });
    return verified ? this.signIn(toPublicUser(verified)) : null;
  }

  resendVerification(email: string): void {
    this.deps.runInBackground(() => this.sendVerificationAgain(normalizeEmail(email)));
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

  requestPasswordReset(email: string): void {
    this.deps.runInBackground(() => this.sendResetLink(normalizeEmail(email)));
  }

  /** Sets the new password and signs the user out everywhere. */
  async resetPassword(token: string, password: string): Promise<boolean> {
    const { prisma } = this.deps;
    const found = await findValidEmailToken(prisma, token, 'reset');
    if (!found) return false;
    const passwordHash = await hashPassword(password);
    return prisma.$transaction(async (tx) => {
      if (!(await markEmailTokenUsed(tx, found.id))) return false;
      await tx.user.update({ where: { id: found.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: found.userId } });
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

  /**
   * A verified account only gets a notice. A pending one takes the new name and password and
   * a fresh link, so an owner who forgot the pending password can start over.
   */
  private async completeRegistration(input: Registration): Promise<void> {
    const email = normalizeEmail(input.email);
    const { prisma } = this.deps;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerifiedAt) {
      await this.mail(
        email,
        templates.alreadyRegistered(this.link('/login'), this.link('/forgot')),
      );
      return;
    }
    const passwordHash = await hashPassword(input.password);
    const token = await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email },
        create: { email, name: input.name, passwordHash },
        update: { name: input.name, passwordHash },
      });
      return issueEmailToken(tx, user.id, 'verify');
    });
    await this.mail(email, templates.verifyEmail(this.tokenLink('/verify', token), input.name));
  }

  private async sendVerificationAgain(email: string): Promise<void> {
    const { prisma } = this.deps;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return;
    const token = await prisma.$transaction((tx) => issueEmailToken(tx, user.id, 'verify'));
    await this.mail(email, templates.verifyEmail(this.tokenLink('/verify', token), user.name));
  }

  /** Only verified accounts get a reset link: reset does not verify and login requires it. */
  private async sendResetLink(email: string): Promise<void> {
    const { prisma } = this.deps;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.emailVerifiedAt) return;
    const token = await prisma.$transaction((tx) => issueEmailToken(tx, user.id, 'reset'));
    await this.mail(email, templates.resetPassword(this.tokenLink('/reset', token)));
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
