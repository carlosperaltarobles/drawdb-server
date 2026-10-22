export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
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
