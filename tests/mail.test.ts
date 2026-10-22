import { describe, expect, it } from 'vitest';
import { MemoryMailer } from '../src/mail/mailer';
import { templates } from '../src/mail/templates';

describe('plantillas de correo', () => {
  it('verifyEmail incluye el enlace en html y text', () => {
    const link = 'http://x/verify?token=abc';
    const t = templates.verifyEmail(link, 'Ana');
    expect(t.subject).toBe('Verifica tu correo — drawDB');
    expect(t.html).toContain(link);
    expect(t.text).toContain(link);
    expect(t.text).toContain('Ana');
  });

  it('el resto de plantillas incluyen sus enlaces', () => {
    const r = templates.resetPassword('http://x/reset?token=t');
    expect(r.html).toContain('http://x/reset?token=t');
    expect(r.text).toContain('http://x/reset?token=t');

    const a = templates.alreadyRegistered('http://x/login', 'http://x/forgot');
    expect(a.text).toContain('http://x/login');
    expect(a.text).toContain('http://x/forgot');
    expect(a.html).toContain('http://x/forgot');

    const i = templates.projectInvite('http://x/register?email=a', 'Proy', 'Luis');
    expect(i.text).toContain('Proy');
    expect(i.text).toContain('Luis');
    expect(i.html).toContain('http://x/register?email=a');

    const p = templates.addedToProject('http://x/projects/1', 'Proy');
    expect(p.html).toContain('http://x/projects/1');
    expect(p.text).toContain('Proy');
  });

  it('escapa HTML en datos de usuario', () => {
    const t = templates.verifyEmail('http://x', '<script>x</script>');
    expect(t.html).not.toContain('<script>');
  });
});

describe('MemoryMailer', () => {
  it('send agrega el mensaje a sent', async () => {
    const m = new MemoryMailer();
    const msg = { to: 'a@b.c', subject: 's', html: '<p>h</p>', text: 'h' };
    await m.send(msg);
    expect(m.sent).toEqual([msg]);
  });
});
