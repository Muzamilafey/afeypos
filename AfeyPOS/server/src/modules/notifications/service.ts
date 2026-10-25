import { Types } from 'mongoose';
import { NotificationLog, NotificationTemplate } from '../../models/index.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { currentContext } from '../../lib/context.js';
import { env } from '../../config/env.js';
import { normalizePhone } from '../../lib/phone.js';
import { createSmsProvider, type SmsProvider } from '../../integrations/sms/index.js';
import { ConsoleEmailProvider, createEmailProvider, SmtpProvider, type EmailProvider } from '../../integrations/email/index.js';
import { IntegrationError } from '../../integrations/http.js';
import { findActiveConfig, openSecrets } from '../integrations/configs.js';
import { DEFAULT_TEMPLATES, render } from './templates.js';

export interface NotifyInput {
  channel: 'sms' | 'email';
  to: string;
  templateKey: string;
  data: Record<string, unknown>;
  dedupeKey?: string;
  ref?: { type: string; id: Types.ObjectId };
  attachments?: undefined;
}

/**
 * Queues a notification. Never throws for delivery problems and never blocks the caller:
 * delivery happens in the background job worker with retries.
 */
export async function notify(input: NotifyInput): Promise<{ queued: boolean; reason?: string }> {
  const tenantId = currentContext()?.tenantId;
  let to = input.to.trim();
  if (input.channel === 'sms') {
    const p = normalizePhone(to);
    if (!p) return { queued: false, reason: 'invalid phone number' };
    to = p;
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { queued: false, reason: 'invalid email' };

  const def = DEFAULT_TEMPLATES[input.templateKey];
  const override = tenantId ? await NotificationTemplate.findOne({ key: input.templateKey, channel: input.channel }).lean() : null;
  let subject: string | undefined;
  let body: string;
  if (input.channel === 'sms') {
    const tpl = override?.body ?? def?.sms;
    if (!tpl) return { queued: false, reason: 'no sms template' };
    body = render(tpl, input.data).slice(0, 640);
  } else {
    const tpl = override ? { subject: override.subject ?? '', body: override.body } : def?.email;
    if (!tpl) return { queued: false, reason: 'no email template' };
    subject = render(tpl.subject, input.data);
    body = render(tpl.body, input.data);
  }
  const dedupeKey = input.dedupeKey ? `${tenantId ?? 'platform'}:${input.channel}:${input.dedupeKey}` : undefined;
  try {
    const log = await NotificationLog.create({ tenantId, channel: input.channel, to, templateKey: input.templateKey, subject, body, dedupeKey, ref: input.ref });
    await enqueue('notification.send', { logId: String(log._id) }, { tenantId: tenantId ?? null, maxAttempts: 6 });
    return { queued: true };
  } catch (err: any) {
    if (err?.code === 11000) return { queued: false, reason: 'duplicate' };
    throw err;
  }
}

function platformEmailProvider(): EmailProvider {
  const e = env();
  if (!e.SMTP_HOST) return new ConsoleEmailProvider();
  return new SmtpProvider({ host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, password: e.SMTP_PASSWORD, from: e.SMTP_FROM });
}

export async function providerFor(channel: 'sms' | 'email'): Promise<SmsProvider | EmailProvider | null> {
  const tenantId = currentContext()?.tenantId;
  if (tenantId) {
    const cfg = await findActiveConfig(channel);
    if (cfg) {
      const secrets = openSecrets(cfg);
      return channel === 'sms' ? createSmsProvider(cfg.provider, cfg.settings ?? {}, secrets, cfg.environment) : createEmailProvider(cfg.provider, cfg.settings ?? {}, secrets);
    }
  }
  if (channel === 'email') return platformEmailProvider();
  return null;
}

// Simple per-tenant rate limiter for outbound messages (per process).
const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(key: string, perMinute = 60): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

registerJob('notification.send', async ({ logId }: { logId: string }, job) => {
  const log = await NotificationLog.findById(logId);
  if (!log || log.status === 'sent' || log.status === 'skipped') return;
  log.attempts += 1;
  const provider = await providerFor(log.channel);
  if (!provider) {
    log.status = 'skipped';
    log.error = `No ${log.channel} provider configured`;
    await log.save();
    return;
  }
  if (!takeToken(`${job.tenantId ?? 'platform'}:${log.channel}`)) throw new Error('Rate limited; will retry');
  try {
    const result =
      log.channel === 'sms'
        ? await (provider as SmsProvider).send(log.to, log.body!)
        : await (provider as EmailProvider).send({ to: log.to, subject: log.subject ?? '', text: log.body! });
    log.status = 'sent';
    log.provider = provider.name;
    log.providerMessageId = result.providerMessageId;
    log.sentAt = new Date();
    log.error = undefined;
    await log.save();
  } catch (err: any) {
    log.provider = provider.name;
    log.error = String(err?.message ?? err).slice(0, 500);
    const retryable = (!(err instanceof IntegrationError) || err.retryable) && log.attempts < 6;
    log.status = retryable ? 'queued' : 'failed';
    await log.save();
    if (retryable) throw err;
  }
});
