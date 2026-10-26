/**
 * Simulated card terminal, for training, demonstrations and automated tests. It never moves money: every
 * transaction made with it is stored with `sandbox: true` and shown as SIMULATED.
 *
 * It behaves like a paired network terminal: it shows a pairing code, rejects a wrong code, authenticates
 * every command with the pairing key, keeps its own record of transactions (queried after a till restart),
 * and can be switched off, disconnected, made busy or given expired credentials from the simulator panel.
 *
 * Test amounts (cents part): .51 declined, .52 cancelled by the customer, .53 connection drops twice while
 * the result is being read, .54 waits until finished from the simulator panel. Anything else is approved.
 */
import crypto from 'node:crypto';
import { TERMINAL_PROVIDER_INFO } from '@afeypos/shared';
import { env } from '../../config/env.js';
import { SimulatedTerminal } from '../../models/index.js';
import { hmacSha256, safeEqual, sha256 } from '../../lib/crypto.js';
import { TerminalError, type TerminalAdapter, type TerminalContext, type TerminalProgress } from './adapter.js';

const MODEL = 'Afey Simulated Terminal';
const PHASES = ['connecting', 'awaiting_card', 'awaiting_pin', 'processing'] as const;

const deviceIdFor = (ctx: TerminalContext) => `SIM-${ctx.terminalId.slice(-8).toUpperCase()}`;
const stepMs = () => env().TERMINAL_SIM_STEP_MS;

async function device(ctx: TerminalContext, opts: { paired?: boolean } = { paired: true }) {
  const d = await SimulatedTerminal.findOne({ deviceId: deviceIdFor(ctx) });
  if (!d) throw new TerminalError('UNREACHABLE', 'No terminal answers at this address');
  if (d.poweredOff) throw new TerminalError('POWERED_OFF', 'The terminal is switched off');
  if (d.disconnected) throw new TerminalError('UNREACHABLE', 'The terminal is not on the network');
  if (ctx.device.serialNumber && ctx.device.serialNumber !== d.deviceId) throw new TerminalError('IDENTITY_MISMATCH', 'Device identity does not match the paired terminal');
  if (opts.paired) {
    if (d.credentialsExpired) throw new TerminalError('CREDENTIALS_EXPIRED', 'Pairing has expired');
    if (!ctx.secrets.pairingKey || !d.pairedKeyHash || !safeEqual(sha256(ctx.secrets.pairingKey), d.pairedKeyHash)) throw new TerminalError('CREDENTIALS_EXPIRED', 'The terminal does not recognise this till’s pairing key');
  }
  return d;
}

function progressOf(p: any, now = Date.now()): TerminalProgress {
  const base = { reference: p.reference, providerRef: p.providerRef, amountCents: p.amountCents, currency: p.currency };
  const final = (status: TerminalProgress['status']): TerminalProgress => {
    if (status !== 'approved') return { ...base, status, message: status === 'declined' ? 'Declined by issuer (simulated)' : status === 'cancelled' ? 'Cancelled on the terminal (simulated)' : undefined };
    return { ...base, status, authCode: `S${sha256(p.reference).slice(0, 5).toUpperCase()}`, cardScheme: 'Visa', last4: '1111', entryMode: 'contactless', removeCard: true, message: 'Approved (simulated, no money moved)' };
  };
  if (p.forced) return final(p.forced);
  const step = stepMs();
  const phase = step > 0 ? Math.floor((now - new Date(p.startedAt).getTime()) / step) : PHASES.length;
  // cancel() refuses an approved payment, so a cancel request always wins over what would come next.
  if (p.cancelRequested) return final('cancelled');
  if (phase < PHASES.length) return { ...base, status: PHASES[phase] };
  if (p.scenario === 'manual') return { ...base, status: 'processing' };
  if (p.scenario === 'declined') return final('declined');
  if (p.scenario === 'cancelled') return final('cancelled');
  return final('approved');
}

const scenarioFor = (amountCents: number) => ({ 51: 'declined', 52: 'cancelled', 53: 'dropout', 54: 'manual' } as Record<number, string>)[amountCents % 100] ?? 'approved';

export class SimulatorTerminalAdapter implements TerminalAdapter {
  readonly capabilities = TERMINAL_PROVIDER_INFO.simulator.capabilities;
  readonly integrationVersion = TERMINAL_PROVIDER_INFO.simulator.integrationVersion!;

  async discover(ctx: TerminalContext) {
    // The simulated terminal "appears" on the network once the merchant switches it on (first discovery).
    await SimulatedTerminal.updateOne({ deviceId: deviceIdFor(ctx) }, { $setOnInsert: { deviceId: deviceIdFor(ctx) } }, { upsert: true });
    const d = await SimulatedTerminal.findOne({ deviceId: deviceIdFor(ctx) });
    if (d?.poweredOff || d?.disconnected) return [];
    return [{ deviceId: deviceIdFor(ctx), model: MODEL, serialNumber: deviceIdFor(ctx), os: 'Simulated', firmware: 'sim-1.0', address: 'simulated' }];
  }

  async register(ctx: TerminalContext, input: { deviceId?: string }) {
    if (input.deviceId && input.deviceId !== deviceIdFor(ctx)) throw new TerminalError('UNREACHABLE', 'No terminal with that identifier answered');
    await this.discover(ctx);
    const d = await device(ctx, { paired: false });
    d.pairingCode = String(crypto.randomInt(100000, 1000000));
    await d.save();
    return {
      device: { model: MODEL, serialNumber: d.deviceId, os: 'Simulated', firmware: 'sim-1.0' },
      pairingHint: 'Enter the pairing code shown on the terminal screen.',
      simulatedScreen: `PAIRING CODE\n${d.pairingCode}`,
    };
  }

  async pair(ctx: TerminalContext, input: { pairingCode: string }) {
    const d = await device(ctx, { paired: false });
    if (!d.pairingCode || !safeEqual(d.pairingCode, input.pairingCode.trim())) throw new TerminalError('PAIRING_REJECTED', 'The pairing code does not match the one on the terminal');
    const pairingKey = crypto.randomBytes(32).toString('base64url');
    d.pairedKeyHash = sha256(pairingKey);
    d.pairingCode = undefined;
    d.credentialsExpired = false;
    await d.save();
    return { secrets: { pairingKey } };
  }

  async status(ctx: TerminalContext) {
    const d = await device(ctx);
    const inProgress = d.payments.some((p) => !['approved', 'declined', 'cancelled'].includes(progressOf(p).status));
    return { online: true, ready: !d.busy && !inProgress, busy: d.busy || inProgress, device: { model: MODEL, serialNumber: d.deviceId, firmware: 'sim-1.0', os: 'Simulated' } };
  }

  async startSale(ctx: TerminalContext, input: { reference: string; amountCents: number; currency: string; kind: 'sale' | 'test' }) {
    const d = await device(ctx);
    if (d.busy) throw new TerminalError('BUSY', 'The terminal is busy with another transaction');
    const existing = d.payments.find((p) => p.reference === input.reference);
    if (existing) return progressOf(existing);
    if (d.payments.some((p) => !['approved', 'declined', 'cancelled'].includes(progressOf(p).status))) throw new TerminalError('BUSY', 'The terminal is busy with another transaction');
    const p = { reference: input.reference, kind: input.kind, amountCents: input.amountCents, currency: input.currency, providerRef: `SIMTX-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, scenario: scenarioFor(input.amountCents), startedAt: new Date(), queries: 0 };
    d.payments.push(p);
    if (d.payments.length > 200) d.payments.splice(0, d.payments.length - 200);
    await d.save();
    return progressOf(p);
  }

  async query(ctx: TerminalContext, input: { reference: string }) {
    const d = await device(ctx);
    const p = d.payments.find((x) => x.reference === input.reference);
    if (!p) return { status: 'failed' as const, reference: input.reference, message: 'The terminal has no transaction with this reference (it was never received)' };
    p.queries = (p.queries ?? 0) + 1;
    await SimulatedTerminal.updateOne({ _id: d._id, 'payments.reference': p.reference }, { $set: { 'payments.$.queries': p.queries } });
    const out = progressOf(p);
    if (p.scenario === 'dropout' && p.queries <= 2 && !['connecting', 'awaiting_card', 'awaiting_pin'].includes(out.status)) {
      throw new TerminalError('UNREACHABLE', 'Connection to the terminal dropped while reading the result', true);
    }
    return out;
  }

  async cancel(ctx: TerminalContext, input: { reference: string }) {
    const d = await device(ctx);
    const p = d.payments.find((x) => x.reference === input.reference);
    if (!p) return;
    if (progressOf(p).status === 'approved') throw new TerminalError('NOT_SUPPORTED', 'The payment was already approved; refund it instead');
    await SimulatedTerminal.updateOne({ _id: d._id, 'payments.reference': p.reference }, { $set: { 'payments.$.cancelRequested': true } });
  }

  async refund(ctx: TerminalContext, input: { reference: string; amountCents: number; currency: string; originalReference: string }) {
    const d = await device(ctx);
    const original = d.payments.find((x) => x.reference === input.originalReference);
    if (!original || progressOf(original).status !== 'approved') throw new TerminalError('NOT_SUPPORTED', 'The terminal has no approved payment to refund');
    return this.startSale(ctx, { reference: input.reference, amountCents: input.amountCents, currency: input.currency, kind: 'sale' });
  }

  verifyNotification(ctx: TerminalContext, input: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; body: any }) {
    const sig = input.headers['x-afey-sim-signature'];
    if (typeof sig !== 'string' || !ctx.secrets.pairingKey) return null;
    if (!safeEqual(hmacSha256(ctx.secrets.pairingKey, input.rawBody.toString('utf8')), sig)) return null;
    return typeof input.body?.reference === 'string' ? { reference: input.body.reference } : null;
  }
}

/** Simulator panel (non-production): switch the simulated device off, disconnect it, make it busy... */
export async function setSimulatedDevice(ctx: Pick<TerminalContext, 'terminalId'>, flags: { poweredOff?: boolean; disconnected?: boolean; credentialsExpired?: boolean; busy?: boolean }) {
  await SimulatedTerminal.updateOne({ deviceId: deviceIdFor(ctx as TerminalContext) }, { $set: flags });
}

/** Simulator panel: finish a waiting simulated transaction with an outcome. */
export async function forceSimulatedOutcome(ctx: Pick<TerminalContext, 'terminalId'>, reference: string, outcome: 'approved' | 'declined' | 'cancelled') {
  await SimulatedTerminal.updateOne({ deviceId: deviceIdFor(ctx as TerminalContext), 'payments.reference': reference }, { $set: { 'payments.$.forced': outcome } });
}

/** Signs a simulated provider notification (used by the simulator panel and tests). */
export const signSimulatedNotification = (pairingKey: string, body: string) => hmacSha256(pairingKey, body);
