import type { User } from '../generated/prisma/client';

export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'isAdmin' | 'isSuperadmin'>;

export function toPublicUser(user: User): PublicUser {
  const { id, email, name, isAdmin, isSuperadmin } = user;
  return { id, email, name, isAdmin, isSuperadmin };
}
