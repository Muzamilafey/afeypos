import { httpJson, IntegrationError } from '../http.js';

export interface SmsSendResult {
  providerMessageId?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(to: string, message: string): Promise<SmsSendResult>;
}

export interface TalkSasaConfig {
  apiToken: string;
  senderId: string;
  baseUrl?: string;
}

/**
 * Talk Sasa bulk SMS (https://bulksms.talksasa.com). Endpoint and payload follow Talk Sasa's v3 HTTP API;
 * confirm against your account's API documentation before going live.
 */
export class TalkSasaProvider implements SmsProvider {
  readonly name = 'talksasa';
  constructor(private cfg: TalkSasaConfig) {}
  async send(to: string, message: string): Promise<SmsSendResult> {
    const base = this.cfg.baseUrl ?? 'https://bulksms.talksasa.com/api/v3';
    const res = await httpJson<any>(`${base}/sms/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ recipient: to, sender_id: this.cfg.senderId, type: 'plain', message }),
    });
    if (res?.status && res.status !== 'success') throw new IntegrationError(`Talk Sasa rejected the message: ${res.message ?? res.status}`, 200, res, false);
    return { providerMessageId: res?.data?.uid ?? res?.data?.id };
  }
}

export interface AfricasTalkingConfig {
  username: string;
  apiKey: string;
  senderId?: string;
  sandbox?: boolean;
}

/** Africa's Talking SMS API (version1/messaging). */
export class AfricasTalkingProvider implements SmsProvider {
  readonly name = 'africastalking';
  constructor(private cfg: AfricasTalkingConfig) {}
  async send(to: string, message: string): Promise<SmsSendResult> {
    const base = this.cfg.sandbox ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
    const form = new URLSearchParams({ username: this.cfg.username, to: `+${to.replace(/^\+/, '')}`, message });
    if (this.cfg.senderId) form.set('from', this.cfg.senderId);
    const res = await httpJson<any>(`${base}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: this.cfg.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const r = res?.SMSMessageData?.Recipients?.[0];
    if (!r || ![100, 101, 102].includes(Number(r.statusCode))) {
      throw new IntegrationError(`Africa's Talking rejected the message: ${r?.status ?? res?.SMSMessageData?.Message ?? 'unknown'}`, 200, res, false);
    }
    return { providerMessageId: r.messageId };
  }
}

/** Development provider: records messages in memory instead of sending. */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  static outbox: { to: string; message: string }[] = [];
  async send(to: string, message: string): Promise<SmsSendResult> {
    ConsoleSmsProvider.outbox.push({ to, message });
    return { providerMessageId: `console-${ConsoleSmsProvider.outbox.length}` };
  }
}

export function createSmsProvider(provider: string, settings: Record<string, any>, secrets: Record<string, any>, environment: string): SmsProvider {
  switch (provider) {
    case 'talksasa':
      return new TalkSasaProvider({ apiToken: secrets.apiToken, senderId: settings.senderId, baseUrl: settings.baseUrl });
    case 'africastalking':
      return new AfricasTalkingProvider({ username: settings.username, apiKey: secrets.apiKey, senderId: settings.senderId, sandbox: environment !== 'production' });
    case 'console':
      return new ConsoleSmsProvider();
    default:
      throw new IntegrationError(`Unknown SMS provider ${provider}`, undefined, undefined, false);
  }
}
