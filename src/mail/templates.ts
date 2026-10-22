export interface Template {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(paragraphs: string[], link: { label: string; url: string }[]): string {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('');
  const links = link.map((l) => `<p><a href="${esc(l.url)}">${esc(l.label)}</a></p>`).join('');
  return `<div style="font-family:sans-serif;line-height:1.5">${body}${links}</div>`;
}

export const templates = {
  verifyEmail(link: string, name: string): Template {
    return {
      subject: 'Verifica tu correo — drawDB',
      html: layout(
        [
          `Hola ${esc(name)}, confirma tu correo para activar tu cuenta. El enlace caduca en 24 horas.`,
        ],
        [{ label: 'Verificar correo', url: link }],
      ),
      text: `Hola ${name}, confirma tu correo para activar tu cuenta (el enlace caduca en 24 horas):\n${link}`,
    };
  },

  resetPassword(link: string): Template {
    return {
      subject: 'Restablece tu contraseña — drawDB',
      html: layout(
        [
          'Recibimos una solicitud para restablecer tu contraseña. El enlace caduca en 1 hora. Si no fuiste tú, ignora este correo.',
        ],
        [{ label: 'Restablecer contraseña', url: link }],
      ),
      text: `Recibimos una solicitud para restablecer tu contraseña (el enlace caduca en 1 hora). Si no fuiste tú, ignora este correo:\n${link}`,
    };
  },

  alreadyRegistered(loginLink: string, forgotLink: string): Template {
    return {
      subject: 'Ya tienes una cuenta — drawDB',
      html: layout(
        ['Alguien intentó registrarse con este correo, pero ya existe una cuenta.'],
        [
          { label: 'Iniciar sesión', url: loginLink },
          { label: 'Olvidé mi contraseña', url: forgotLink },
        ],
      ),
      text: `Alguien intentó registrarse con este correo, pero ya existe una cuenta.\nIniciar sesión: ${loginLink}\nOlvidé mi contraseña: ${forgotLink}`,
    };
  },

  projectInvite(link: string, projectName: string, inviter: string): Template {
    return {
      subject: `${inviter} te invitó al proyecto "${projectName}" — drawDB`,
      html: layout(
        [
          `${esc(inviter)} te invitó a colaborar en el proyecto <b>${esc(projectName)}</b>. La invitación caduca en 14 días.`,
        ],
        [{ label: 'Aceptar invitación', url: link }],
      ),
      text: `${inviter} te invitó a colaborar en el proyecto "${projectName}" (la invitación caduca en 14 días):\n${link}`,
    };
  },

  addedToProject(link: string, projectName: string): Template {
    return {
      subject: `Te añadieron al proyecto "${projectName}" — drawDB`,
      html: layout(
        [`Ahora tienes acceso al proyecto <b>${esc(projectName)}</b>.`],
        [{ label: 'Abrir proyecto', url: link }],
      ),
      text: `Ahora tienes acceso al proyecto "${projectName}":\n${link}`,
    };
  },
};
