import { createTransport } from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer';
import type { config } from '../config';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Attachment[];
}

export interface Mailer {
  send(m: Mail): Promise<void>;
}

export class MemoryMailer implements Mailer {
  sent: Mail[] = [];

  async send(m: Mail): Promise<void> {
    this.sent.push(m);
  }
}

export function createSmtpMailer(cfg: typeof config.mail): Mailer {
  const transporter = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
  });
  return {
    async send(m) {
      await transporter.sendMail({
        from: cfg.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        attachments: m.attachments,
      });
    },
  };
}
