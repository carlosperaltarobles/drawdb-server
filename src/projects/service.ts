import type { PublicUser } from '../auth/public-user';
import { notifyRooms, type CollabHooks } from '../collab/hooks';
import type { PrismaClient } from '../db/prisma';
import { AppError } from '../http/app-error';
import { EMPTY_DOC } from './empty-doc';
import { getRole, type AccessRole } from './repo';

export type ProjectsServiceDeps = { prisma: PrismaClient; rooms?: CollabHooks };

export type ProjectRef = { id: string; name: string };
export type ProjectSummary = ProjectRef & { role: AccessRole; updatedAt: Date };

/** Projects as seen by one user. Administrators see and manage every project. */
export class ProjectsService {
  constructor(private readonly deps: ProjectsServiceDeps) {}

  async list(user: PublicUser): Promise<ProjectSummary[]> {
    const { prisma } = this.deps;
    const fields = { id: true, name: true, updatedAt: true } as const;
    if (user.isAdmin) {
      const projects = await prisma.project.findMany({
        select: fields,
        orderBy: { updatedAt: 'desc' },
      });
      return projects.map((p) => ({ ...p, role: 'admin' }));
    }
    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { role: true, project: { select: fields } },
      orderBy: { project: { updatedAt: 'desc' } },
    });
    return memberships.map(({ role, project }) => ({ ...project, role }));
  }

  /** Not found and no access look the same, so the answer does not reveal the project exists. */
  async get(id: string, user: PublicUser): Promise<ProjectRef & { role: AccessRole }> {
    const { prisma } = this.deps;
    const [project, role] = await Promise.all([
      prisma.project.findUnique({ where: { id }, select: { name: true } }),
      getRole(prisma, id, user),
    ]);
    if (!project || !role) throw new AppError('not_found');
    return { id, name: project.name, role };
  }

  create(name: string, creator: PublicUser): Promise<ProjectRef> {
    return this.deps.prisma.project.create({
      data: { name, diagram: EMPTY_DOC, createdBy: creator.id },
      select: { id: true, name: true },
    });
  }

  async rename(id: string, name: string): Promise<ProjectRef> {
    const { count } = await this.deps.prisma.project.updateMany({ where: { id }, data: { name } });
    if (count === 0) throw new AppError('not_found');
    await notifyRooms(() => this.deps.rooms?.onProjectRenamed(id, name));
    return { id, name };
  }

  /** Members, invitations and snapshots go with it (ON DELETE CASCADE). */
  async remove(id: string): Promise<void> {
    const { count } = await this.deps.prisma.project.deleteMany({ where: { id } });
    if (count === 0) throw new AppError('not_found');
    await notifyRooms(() => this.deps.rooms?.onProjectDeleted(id));
  }
}
