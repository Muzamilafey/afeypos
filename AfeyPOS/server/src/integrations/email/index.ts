import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ providerMessageId?: string }>;
  verify(): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from: string;
}

export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  private transport;
  constructor(private cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure ?? cfg.port === 465,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
      connectionTimeout: 15000,
    });
  }
  async send(msg: EmailMessage) {
    const info = await this.transport.sendMail({ from: this.cfg.from, ...msg });
    return { providerMessageId: info.messageId };
  }
  async verify() {
    await this.transport.verify();
  }
}

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  static outbox: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    ConsoleEmailProvider.outbox.push(msg);
    return { providerMessageId: `console-${ConsoleEmailProvider.outbox.length}` };
  }
  async verify() {}
}

export function createEmailProvider(provider: string, settings: Record<string, any>, secrets: Record<string, any>): EmailProvider {
  if (provider === 'console') return new ConsoleEmailProvider();
  return new SmtpProvider({ host: settings.host, port: Number(settings.port ?? 587), secure: settings.secure, user: settings.user, password: secrets.password, from: settings.from });
}
