/**
 * The fiscal adapter for a configured device: wraps the existing OSCU / VSCU client, the ETR program gateway and
 * the simulators in the manufacturer-neutral FiscalAdapter shape, with each one's real capabilities.
 */
import fs from 'node:fs';
import { IntegrationConfig } from '../../models/index.js';
import { EtimsClient, MockEtimsGateway, type EtimsGateway, type EtimsSale } from '../../integrations/etims/client.js';
import { EtrGateway, type EtrConfig } from '../../integrations/etims/etr.js';
import {
  FiscalUnsupportedError, type DeviceInfo, type DeviceStatus, type FiscalAdapter, type FiscalCapabilities, type FiscalKind, type FiscalSignature, type StatusAnswer,
} from '../../integrations/fiscal/adapter.js';
import { openSecrets } from '../integrations/configs.js';

type Cfg = InstanceType<typeof IntegrationConfig>;

export function fiscalKind(cfg: { provider: string; settings?: any }): FiscalKind {
  if (cfg.provider === 'mock') return 'mock';
  if (cfg.provider === 'vscu') return 'vscu';
  if (cfg.provider === 'etr') {
    const c = cfg.settings?.connection;
    return c === 'folder' ? 'etr_folder' : c === 'simulator' ? 'etr_simulator' : 'etr_http';
  }
  return 'oscu';
}

export const KIND_LABEL: Record<FiscalKind, string> = {
  oscu: 'KRA eTIMS OSCU (online)', vscu: 'KRA eTIMS VSCU (shop network)', etr_http: 'ETR device: maker\'s program (web address)', etr_folder: 'ETR device: maker\'s program (folders)', etr_simulator: 'ETR simulator', mock: 'eTIMS simulator',
};

const NONE: FiscalCapabilities = { submitInvoice: false, submitCreditNote: false, submitDebitNote: false, cancelTransaction: false, transactionStatus: false, lastFiscalReceipt: false, deviceInfo: true, initialize: false, itemRegistration: false, safeResend: false, localOnly: false };

/**
 * What each kind supports. Debit notes and cancellation are not offered: Afey POS has no debit note document and
 * neither eTIMS sales API nor the ETR programs we support document a cancel; a sale is reversed with a credit note.
 */
export function fiscalCapabilities(cfg: { provider: string; settings?: any }): FiscalCapabilities {
  const k = fiscalKind(cfg);
  const sells = { submitInvoice: true, submitCreditNote: true };
  switch (k) {
    // KRA refuses a second invoice with the same invoice number, and Afey POS always resends the same number.
    case 'oscu': return { ...NONE, ...sells, initialize: true, itemRegistration: true, safeResend: true };
    case 'vscu': return { ...NONE, ...sells, initialize: true, itemRegistration: true, safeResend: true, localOnly: true };
    // Status query only where the installer set the program's documented status address.
    case 'etr_http': return { ...NONE, ...sells, initialize: true, transactionStatus: Boolean(cfg.settings?.statusPath), localOnly: true };
    // The invoice file is written once; the answer file is the status.
    case 'etr_folder': return { ...NONE, ...sells, initialize: true, transactionStatus: true, safeResend: true, localOnly: true };
    case 'etr_simulator': return { ...NONE, ...sells, initialize: true, transactionStatus: true, safeResend: true };
    case 'mock': return { ...NONE, ...sells, initialize: true, itemRegistration: true, transactionStatus: true, lastFiscalReceipt: true, safeResend: true };
  }
}

export function etimsGateway(cfg: Cfg): EtimsGateway {
  if (cfg.provider === 'mock') return new MockEtimsGateway(String(cfg._id));
  const s = cfg.settings ?? {};
  if (cfg.provider === 'etr') {
    // An ETR device on this computer, through the program that comes with it.
    const etr: EtrConfig = {
      connection: s.connection === 'folder' || s.connection === 'simulator' ? s.connection : 'http', url: s.url, invoicePath: s.invoicePath, inbox: s.inbox, outbox: s.outbox,
      cuSerial: s.cuSerial, timeoutSeconds: Number(s.timeoutSeconds) || undefined, fieldInvoice: s.fieldInvoice, fieldSerial: s.fieldSerial, fieldQr: s.fieldQr, fieldDate: s.fieldDate,
      statusPath: s.statusPath || undefined, authHeader: openSecrets(cfg).authHeader,
    };
    return new EtrGateway(etr, { name: s.registeredName, pin: s.tin });
  }
  return new EtimsClient({
    mode: cfg.provider === 'vscu' ? 'vscu' : 'oscu', environment: cfg.environment as 'sandbox' | 'production',
    tin: String(s.tin ?? ''), bhfId: String(s.bhfId ?? '00'), dvcSrlNo: s.dvcSrlNo, baseUrl: s.baseUrl, cmcKey: openSecrets(cfg).cmcKey,
  });
}

async function reachable(url: string, ms = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { ok: true, message: `answers (HTTP ${r.status})` };
  } catch (err: any) {
    return { ok: false, message: err?.cause?.code ?? err?.message ?? 'no answer' };
  }
}

class ConfiguredAdapter implements FiscalAdapter {
  readonly kind: FiscalKind;
  private gw: EtimsGateway;
  constructor(private cfg: Cfg) {
    this.kind = fiscalKind(cfg);
    this.gw = etimsGateway(cfg);
  }

  getCapabilities() {
    return fiscalCapabilities(this.cfg);
  }
  async connect() {}
  async disconnect() {}

  validateConfiguration() {
    const s = this.cfg.settings ?? {};
    const problems: string[] = [];
    if (!/^[AP]\d{9}[A-Z]$/.test(String(s.tin ?? ''))) problems.push('KRA PIN is missing or not in the form P051234567X');
    if (!/^\d{2}$/.test(String(s.bhfId ?? ''))) problems.push('KRA branch id must be two digits ("00" for head office)');
    if ((this.kind === 'mock' || this.kind === 'etr_simulator') && this.cfg.environment === 'production') problems.push('A simulator cannot be used in production');
    if (this.kind === 'oscu' || this.kind === 'vscu') {
      if (!openSecrets(this.cfg).cmcKey) problems.push('Not initialised with KRA yet (press Initialise)');
      if (this.kind === 'vscu' && !s.baseUrl) problems.push('VSCU address is missing');
    }
    if (this.kind === 'etr_http' && !s.url) problems.push('Address of the ETR program is missing');
    if (this.kind === 'etr_http' && !s.statusPath) problems.push('No status address for the ETR program: an invoice whose answer is lost goes to reconciliation instead of being checked automatically');
    if (this.kind === 'etr_folder' && (!s.inbox || !s.outbox)) problems.push('Inbox and outbox folders are required');
    return problems;
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const s = this.cfg.settings ?? {};
    return {
      kind: this.kind, label: KIND_LABEL[this.kind], serial: s.dvcSrlNo ?? s.cuSerial ?? undefined, sdcId: s.sdcId, mrcNo: s.mrcNo, taxpayer: s.registeredName, branch: s.branchName,
      endpoint: this.kind === 'etr_folder' ? `${s.inbox} → ${s.outbox}` : this.kind === 'etr_http' ? s.url : this.kind === 'vscu' ? s.baseUrl : this.kind === 'oscu' ? (s.baseUrl || (this.cfg.environment === 'production' ? 'KRA eTIMS (production)' : 'KRA eTIMS (sandbox)')) : 'simulator',
    };
  }

  /** Cheap check, used by the health monitor: never sends a fiscal command. */
  async getStatus(): Promise<DeviceStatus> {
    const s = this.cfg.settings ?? {};
    if (!this.cfg.enabled) return { state: 'unknown', message: 'Turned off' };
    switch (this.kind) {
      case 'mock':
      case 'etr_simulator':
        return { state: 'online', message: 'Simulator' };
      case 'etr_folder':
        try {
          for (const d of [s.inbox, s.outbox]) fs.accessSync(String(d), fs.constants.R_OK | fs.constants.W_OK);
          return { state: 'online', message: 'Folders usable' };
        } catch (err: any) {
          return { state: 'offline', message: `Folder not usable (${err?.code ?? err?.message})` };
        }
      case 'etr_http': {
        const r = await reachable(String(s.url ?? ''));
        return r.ok ? { state: 'online', message: `ETR program ${r.message}` } : { state: 'offline', message: `ETR program not reached (${r.message})` };
      }
      case 'vscu': {
        if (!openSecrets(this.cfg).cmcKey) return { state: 'offline', message: 'Not initialised' };
        const r = await reachable(String(s.baseUrl ?? ''));
        return r.ok ? { state: 'online', message: `VSCU ${r.message}` } : { state: 'offline', message: `VSCU not reached (${r.message})` };
      }
      case 'oscu':
        // KRA's API is not polled: its state comes from the invoices actually sent.
        return openSecrets(this.cfg).cmcKey ? { state: 'unknown', message: 'Judged from the invoices sent' } : { state: 'offline', message: 'Not initialised' };
    }
  }

  /** Asked for by a person: also checks that KRA's address answers at all (a plain web request, no fiscal call). */
  async testConnection(): Promise<DeviceStatus> {
    if (this.kind !== 'oscu') return this.getStatus();
    if (!openSecrets(this.cfg).cmcKey) return { state: 'offline', message: 'Not initialised with KRA yet' };
    const base = (this.gw as EtimsClient).baseUrl;
    const r = await reachable(base, 8000);
    return r.ok ? { state: 'online', message: `KRA eTIMS ${r.message}` } : { state: 'offline', message: `KRA eTIMS not reached (${r.message})` };
  }

  async submitInvoice(sale: EtimsSale): Promise<FiscalSignature> {
    return this.gw.saveSale(sale);
  }
  async submitCreditNote(note: EtimsSale): Promise<FiscalSignature> {
    if (note.rcptTyCd !== 'R') throw new FiscalUnsupportedError('A credit note without receipt type R', this.kind);
    return this.gw.saveSale(note);
  }
  async submitDebitNote(): Promise<FiscalSignature> {
    throw new FiscalUnsupportedError('Debit notes', KIND_LABEL[this.kind]);
  }
  async getTransactionStatus(sale: EtimsSale): Promise<StatusAnswer> {
    if (!this.getCapabilities().transactionStatus || !this.gw.findSale) throw new FiscalUnsupportedError('Asking for an invoice\'s status', KIND_LABEL[this.kind]);
    const sig = await this.gw.findSale(sale);
    return sig ? { found: true, signature: sig } : { found: false };
  }
  async getLastFiscalReceipt(): Promise<FiscalSignature | null> {
    if (this.kind !== 'mock') throw new FiscalUnsupportedError('Reading the last fiscal receipt', KIND_LABEL[this.kind]);
    const last = [...MockEtimsGateway.recorded.values()].at(-1);
    return last ?? null;
  }
  async cancelTransaction(): Promise<void> {
    throw new FiscalUnsupportedError('Cancelling an invoice (issue a credit note instead)', KIND_LABEL[this.kind]);
  }
}

export function fiscalAdapter(cfg: Cfg): FiscalAdapter {
  return new ConfiguredAdapter(cfg);
}
