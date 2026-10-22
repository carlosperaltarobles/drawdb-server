import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_DOMAIN, makeApp } from '../helpers/app';
import { testPrisma } from '../helpers/db';
import { PASSWORD, tokenFromMail } from '../helpers/users';

afterAll(async () => {
  await testPrisma().$disconnect();
});

const EMAIL = `eva@${ALLOWED_DOMAIN}`;
const DAY = 24 * 60 * 60 * 1000;

describe('invitaciones pendientes al verificar', () => {
  it('convierte en miembro las vigentes y deja las caducadas', async () => {
    const { app, prisma, mailer, settle } = await makeApp();
    const [open, expired] = await Promise.all(
      ['Abierto', 'Caducado'].map((name) => prisma.project.create({ data: { name, diagram: {} } })),
    );
    await prisma.projectInvitation.createMany({
      data: [
        {
          projectId: open.id,
          email: EMAIL,
          role: 'editor',
          tokenHash: 'a',
          expiresAt: new Date(Date.now() + DAY),
        },
        {
          projectId: expired.id,
          email: EMAIL,
          role: 'viewer',
          tokenHash: 'b',
          expiresAt: new Date(Date.now() - DAY),
        },
      ],
    });

    await request(app)
      .post('/api/auth/register')
      .send({ email: EMAIL, name: 'Eva', password: PASSWORD });
    await settle();
    const token = tokenFromMail(mailer.sent[0].text, '/verify');
    const res = await request(app).post('/api/auth/verify').send({ token, password: PASSWORD });
    expect(res.status).toBe(200);

    const members = await prisma.projectMember.findMany();
    expect(members).toEqual([{ projectId: open.id, userId: res.body.user.id, role: 'editor' }]);
    const accepted = await prisma.projectInvitation.findFirstOrThrow({
      where: { projectId: open.id },
    });
    expect(accepted.acceptedAt).not.toBeNull();
    const pending = await prisma.projectInvitation.findFirstOrThrow({
      where: { projectId: expired.id },
    });
    expect(pending.acceptedAt).toBeNull();
  });
});
