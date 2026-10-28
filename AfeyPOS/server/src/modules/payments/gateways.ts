/**
 * Payment gateway intents (Paystack, Flutterwave, pawaPay, Airtel Money, Kopo Kopo, Hubtel, iPay, ZenoPay,
 * Africa's Talking, simulator).
 *
 * Same guarantees as M-Pesa: starting a charge creates a *pending* intent; it becomes "succeeded" only after an
 * authenticated status call to the provider confirms it with the expected amount and currency. Webhooks are
 * authenticated (provider signature / shared secret / per-tenant callback token) and then only trigger that
 * verification. Sales consume succeeded intents through the atomic claim in checkout.
 */
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { formatMoney, PAYMENT_PROVIDER_INFO, paymentCurrency, type PaymentProviderKey } from '@afeypos/shared';
import { env } from '../../config/env.js';
import { IntegrationConfig, MpesaEvent, PaymentIntent, Tenant, Till, type IntegrationConfigDoc, type PaymentIntentDoc } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { safeEqual } from '../../lib/crypto.js';
import { runInTenant } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { IntegrationError } from '../../integrations/http.js';
import { createPaymentGateway, SimulatorGateway, type PaymentGateway, type VerifyOutput } from '../../integrations/payments/index.js';
import { dialCode, toMsisdn } from '../../integrations/payments/util.js';
import { openSecrets } from '../integrations/configs.js';
import { finalizeIntent, presentIntent } from './intents.js';
import { notify } from '../notifications/service.js';
import { normalizePhone } from '../../lib/phone.js';

export function paymentGatewayFor(cfg: Pick<IntegrationConfigDoc, '_id' | 'provider' | 'environment' | 'settings' | 'secretsEnc'>): PaymentGateway {
  if (cfg.provider === 'simulator' && env().NODE_ENV === 'production' && cfg.environment === 'production') throw badRequest('The payment simulator cannot be used in production');
  return createPaymentGateway({ provider: cfg.provider as PaymentProviderKey, environment: cfg.environment as 'sandbox' | 'production', settings: cfg.settings ?? {}, secrets: openSecrets(cfg) });
}

export function gatewayCallbackUrl(tenantId: Types.ObjectId | string, token: string, configId: Types.ObjectId | string) {
  return `${env().API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/hooks/pay/${tenantId}/${token}/gw/${configId}`;
}

const returnUrl = (reference: string) => `${env().API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/public/payment-return?ref=${encodeURIComponent(reference)}`;

async function logEvent(kind: 'gateway_webhook' | 'gateway_verify', data: { provider?: string; configId?: unknown; payload?: unknown; ip?: string; outcome?: string; error?: string; paymentIntentId?: unknown }) {
  try {
    await MpesaEvent.create({ kind, ...data });
  } catch (err) {
    logger.warn({ err }, 'could not record payment event');
  }
}

/**
 * Asks the provider for the intent's status and applies it. `final` expires intents still pending.
 * Also records confirmations that arrive after the intent was cancelled/expired, for reconciliation.
 */
export async function verifyGatewayIntent(intent: PaymentIntentDoc, final: boolean): Promise<string> {
  const cfg = await IntegrationConfig.findById(intent.configId);
  if (!cfg || !intent.reference) {
    if (final && intent.status === 'pending') await finalizeIntent(intent, { status: 'expired', resultDesc: 'Gateway configuration missing' });
    return 'no_config';
  }
  let r: VerifyOutput;
  try {
    r = await paymentGatewayFor(cfg).verify({ reference: intent.reference, providerRef: intent.providerRef ?? undefined, currency: intent.currency ?? undefined });
  } catch (err: any) {
    await logEvent('gateway_verify', { provider: intent.provider, configId: cfg._id, paymentIntentId: intent._id, outcome: 'error', error: err?.message });
    if (final && intent.status === 'pending') await finalizeIntent(intent, { status: 'expired', resultDesc: `Could not confirm with ${PAYMENT_PROVIDER_INFO[intent.provider as PaymentProviderKey]?.label ?? intent.provider}: ${err?.message}` });
    if (err instanceof IntegrationError && !final) return 'provider_error';
    if (final) return 'expired';
    throw err;
  }
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { lastQueriedAt: new Date() } });
  let outcome: string = r.status;

  if (intent.status !== 'pending') {
    // Late confirmation after the cashier gave up: keep it visible for reconciliation, never auto-allocate.
    if (r.status === 'succeeded' && !intent.receiptNumber && intent.status !== 'succeeded') {
      await PaymentIntent.updateOne(
        { _id: intent._id },
        { $set: { receiptNumber: r.receiptNumber ?? intent.reference, resultDesc: `Late confirmation after ${intent.status}`, paidAmountCents: r.paidAmountCents ?? intent.amountCents } },
      ).catch(() => undefined);
      outcome = 'late_confirmation';
    } else outcome = 'duplicate';
  } else if (r.status === 'succeeded') {
    const amountOk = r.paidAmountCents === undefined || r.paidAmountCents === intent.amountCents;
    const currencyOk = !r.currency || !intent.currency || r.currency.toUpperCase() === intent.currency.toUpperCase();
    if (!amountOk || !currencyOk) {
      await finalizeIntent(intent, { status: 'failed', resultDesc: `Amount/currency mismatch: expected ${intent.currency ?? ''} ${intent.amountCents / 100}, provider reported ${r.currency ?? ''} ${(r.paidAmountCents ?? 0) / 100}` });
      outcome = 'amount_mismatch';
    } else {
      await finalizeIntent(intent, { status: 'succeeded', resultCode: 0, resultDesc: r.message ?? 'Confirmed by provider status check', receiptNumber: r.receiptNumber ?? intent.reference, paidAmountCents: intent.amountCents, phone: r.phone, payerName: r.payerName });
    }
  } else if (r.status !== 'pending') {
    await finalizeIntent(intent, { status: r.status, resultDesc: r.message ?? r.status });
  } else if (final) {
    await finalizeIntent(intent, { status: 'expired', resultDesc: r.message ? `Not confirmed in time (${r.message})` : 'Not confirmed in time' });
    outcome = 'expired';
  }
  await logEvent('gateway_verify', { provider: intent.provider, configId: cfg._id, paymentIntentId: intent._id, outcome, payload: r.raw });
  return outcome;
}

registerJob('payments.checkIntent', async ({ intentId, final }: { intentId: string; final?: boolean }) => {
  const i = await PaymentIntent.findById(intentId);
  if (!i || i.status !== 'pending') return;
  await verifyGatewayIntent(i, Boolean(final));
});

async function gatewaysForBranch(branchId?: Types.ObjectId | null) {
  const configs = await IntegrationConfig.find({ kind: 'payment', enabled: true }).sort({ isDefault: -1, createdAt: 1 });
  return configs.filter((c) => {
    const info = PAYMENT_PROVIDER_INFO[c.provider as PaymentProviderKey];
    if (!info || info.availability !== 'available') return false;
    if (info.devOnly && env().NODE_ENV === 'production' && c.environment === 'production') return false;
    return !c.branchIds.length || !branchId || c.branchIds.some((b) => String(b) === String(branchId));
  });
}

const router = Router();

/**
 * Payment link gateways (Pesapal and others without a direct phone prompt): the till sends the link to the
 * customer's phone by SMS; they open it, choose M-Pesa (the prompt comes on their phone), Airtel Money or card.
 */
router.post('/payments/intents/:id/send-link', requirePermission('sales.create'), async (req, res) => {
  const body = parse(z.object({ phone: z.string().trim().min(9).max(20) }), req.body);
  const intent = await PaymentIntent.findById(idParam(req.params.id));
  if (!intent || intent.status !== 'pending' || !intent.checkoutUrl) throw notFound('Payment link');
  if (!req.capabilities!.modules.includes('sms')) throw unprocessable('Turn on the SMS module (Settings › Modules) and connect an SMS provider to send links', 'SMS_DISABLED');
  const phone = normalizePhone(body.phone);
  if (!phone) throw badRequest('Enter the customer’s phone number, e.g. 0712345678');
  const r = await notify({
    channel: 'sms', to: phone, templateKey: 'paymentLink', dedupeKey: `paylink:${intent._id}:${phone}`, ref: { type: 'PaymentIntent', id: intent._id },
    data: { business: req.tenant!.name, amount: formatMoney(intent.amountCents, intent.currency ?? req.tenant!.settings?.currency ?? 'KES'), url: intent.checkoutUrl, reference: intent.reference ?? String(intent._id).slice(-8) },
  });
  if (!r.queued) throw unprocessable(`The SMS was not sent: ${r.reason}`, 'SMS_NOT_SENT');
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { phone } });
  await audit(req, { action: 'payment.link_sent', entity: 'PaymentIntent', entityId: intent._id, details: { phone: phone.replace(/\d(?=\d{3})/g, '*') } });
  res.json({ data: { sent: true, phone } });
});

/** Gateways a cashier can use at this till (no secrets). */
router.get('/payments/gateways', requirePermission('sales.create'), async (req, res) => {
  const q = parse(z.object({ tillId: objectId.optional() }), req.query);
  const till = q.tillId ? await Till.findById(q.tillId).lean() : null;
  const t = req.tenant!;
  const data = (await gatewaysForBranch(till?.branchId)).map((c) => {
    const info = PAYMENT_PROVIDER_INFO[c.provider as PaymentProviderKey];
    return {
      id: c._id, provider: c.provider, name: c.name, label: info.label, flows: info.flows, channels: info.channels, environment: c.environment,
      currency: paymentCurrency(info.key, undefined, c.settings?.currency, t.settings?.currency ?? 'KES'), devOnly: Boolean(info.devOnly),
    };
  });
  res.json({ data });
});

const chargeSchema = z.object({
  clientRequestId: z.string().min(8).max(100),
  amountCents: positiveCents.refine((v) => v >= 100, 'Amount is too small'),
  flow: z.enum(['push', 'link']).default('push'),
  phone: z.string().min(7).max(20).optional(),
  email: z.string().email().max(120).optional(),
  customerName: z.string().trim().max(80).optional(),
  channel: z.string().max(60).optional(),
  tillId: objectId.optional(),
  customerId: objectId.optional(),
  description: z.string().trim().max(60).optional(),
});

/** Starts a gateway payment (phone prompt or hosted checkout link) and its status checks. Used by the till and the online shop. */
export async function startGatewayCharge(opts: {
  tenant: any; cfg: any; clientRequestId: string; amountCents: number; flow: 'push' | 'link'; channel?: string; phone?: string; email?: string; customerName?: string;
  description?: string; branchId?: unknown; tillId?: unknown; initiatedBy?: unknown; redirectUrl?: (reference: string) => string; onlineOrderId?: unknown;
}) {
  const { tenant, cfg } = opts;
  const info = PAYMENT_PROVIDER_INFO[cfg.provider as PaymentProviderKey];
  if (!info.flows.includes(opts.flow)) throw badRequest(`${info.label} does not support ${opts.flow === 'link' ? 'payment links' : 'phone prompts'}`);
  if (opts.flow === 'push' && info.channels.length && !info.channels.some((c) => c.value === opts.channel)) throw badRequest('Select the customer’s mobile network');
  const channel = opts.flow === 'push' ? opts.channel : undefined;
  const currency = paymentCurrency(info.key, channel, cfg.settings?.currency, tenant.settings?.currency ?? 'KES');
  let phone: string | undefined;
  if (opts.flow === 'push') {
    if (!opts.phone) throw badRequest('Enter the customer’s phone number');
    phone = toMsisdn(opts.phone, dialCode(currency, channel)) ?? undefined;
    if (!phone) throw badRequest('Enter a valid phone number, e.g. 0712345678');
    // Mobile money moves whole units only.
    if (opts.amountCents % 100 !== 0) throw badRequest('Mobile money amounts must be whole units');
  } else if (opts.phone) {
    // Payment link: the provider's checkout page starts with the customer's number filled in.
    phone = toMsisdn(opts.phone, dialCode(currency, channel)) ?? undefined;
  }
  const email = opts.email || String(cfg.settings?.customerEmail || '') || `pos+${tenant.slug}@example.com`;
  const gateway = paymentGatewayFor(cfg);
  const reference = gateway.newReference?.() ?? new Types.ObjectId().toHexString() + Math.random().toString(16).slice(2, 10);
  const [intent] = await PaymentIntent.create([{
    provider: cfg.provider, source: opts.flow, status: 'pending', clientRequestId: opts.clientRequestId, amountCents: opts.amountCents, currency, channel,
    phone, payerName: opts.customerName, reference, branchId: opts.branchId, tillId: opts.tillId, configId: cfg._id, initiatedBy: opts.initiatedBy, onlineOrderId: opts.onlineOrderId,
  }]);
  try {
    const out = await gateway.charge({
      reference, amountCents: opts.amountCents, currency, flow: opts.flow, phone, email, customerName: opts.customerName, channel,
      description: opts.description || `${tenant.name} payment`.slice(0, 60), callbackUrl: gatewayCallbackUrl(tenant._id, tenant.callbackToken, cfg._id), redirectUrl: (opts.redirectUrl ?? returnUrl)(reference),
    });
    if (out.status === 'failed') {
      await PaymentIntent.updateOne({ _id: intent._id }, { $set: { status: 'failed', resultDesc: out.message, completedAt: new Date() } });
      await logEvent('gateway_verify', { provider: cfg.provider, configId: cfg._id, paymentIntentId: intent._id, outcome: 'charge_rejected', payload: out.raw });
      throw unprocessable(`${info.label} rejected the request: ${out.message ?? 'unknown reason'}`, 'PAYMENT_REJECTED');
    }
    intent.providerRef = out.providerRef;
    intent.checkoutUrl = out.checkoutUrl;
    if (out.message) intent.resultDesc = out.message;
    await intent.save();
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    await PaymentIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'failed', resultDesc: `Could not reach ${info.label}: ${err?.message}`, completedAt: new Date() } });
    logger.warn({ err: err?.message, provider: cfg.provider }, 'gateway charge failed');
    throw new AppError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', `Could not reach ${info.label}. Try again or use another payment method.`);
  }
  // Safety net when no webhook arrives: poll the provider, then expire.
  const timeoutSec = opts.flow === 'link' ? Number(cfg.settings?.linkTimeoutMinutes ?? 15) * 60 : (tenant.settings?.stkPendingTimeoutSeconds ?? 180);
  for (const [n, delay] of [[1, 30], [2, 90]] as const) {
    if (delay < timeoutSec) await enqueue('payments.checkIntent', { intentId: String(intent._id) }, { runAt: new Date(Date.now() + delay * 1000), dedupeKey: `pay-check:${intent._id}:${n}` });
  }
  await enqueue('payments.checkIntent', { intentId: String(intent._id), final: true }, { runAt: new Date(Date.now() + timeoutSec * 1000), dedupeKey: `pay-check:${intent._id}:final` });
  return { intent, currency, phone };
}

router.post('/payments/gateways/:id/charge', requirePermission('sales.create'), async (req, res) => {
  const body = parse(chargeSchema, req.body);
  const existing = await PaymentIntent.findOne({ clientRequestId: body.clientRequestId }).lean();
  if (existing) {
    res.json({ data: presentIntent(existing), replay: true });
    return;
  }
  const till = body.tillId ? await Till.findById(body.tillId).lean() : null;
  const cfg = (await gatewaysForBranch(till?.branchId)).find((c) => String(c._id) === String(idParam(req.params.id)));
  if (!cfg) throw new AppError(409, 'GATEWAY_NOT_AVAILABLE', 'This payment gateway is not enabled for this branch');
  const { intent, currency, phone } = await startGatewayCharge({ tenant: req.tenant!, cfg, clientRequestId: body.clientRequestId, amountCents: body.amountCents, flow: body.flow, channel: body.channel, phone: body.phone, email: body.email, customerName: body.customerName, description: body.description, branchId: till?.branchId, tillId: till?._id, initiatedBy: req.auth!.userId });
  await audit(req, { action: 'payment.charge_initiated', entity: 'PaymentIntent', entityId: intent._id, details: { provider: cfg.provider, flow: body.flow, amountCents: body.amountCents, currency, phone: phone?.replace(/\d(?=\d{3})/g, '*') } });
  res.status(201).json({ data: presentIntent(intent) });
});

/** Reconciliation for gateway payments: totals per provider/status, unallocated and late confirmations. */
router.get('/payments/online/reconciliation', requirePermission('payments.reconcile'), async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), provider: z.string().max(40).optional() }), req.query);
  const match: Record<string, unknown> = { provider: q.provider && q.provider !== 'mpesa' ? q.provider : { $ne: 'mpesa' } };
  if (q.from || q.to) match.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [summary, unallocated, late, recent] = await Promise.all([
    PaymentIntent.aggregate([{ $match: match }, { $group: { _id: { provider: '$provider', status: '$status' }, count: { $sum: 1 }, amountCents: { $sum: { $ifNull: ['$paidAmountCents', '$amountCents'] } }, allocatedCents: { $sum: '$allocatedCents' } } }]),
    PaymentIntent.find({ ...match, status: 'succeeded', $expr: { $lt: ['$allocatedCents', '$paidAmountCents'] } }).sort({ createdAt: -1 }).limit(200).lean(),
    PaymentIntent.find({ ...match, status: { $in: ['cancelled', 'expired'] }, receiptNumber: { $exists: true } }).limit(200).lean(),
    PaymentIntent.find(match).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  res.json({ data: { summary, unallocated: unallocated.map(presentIntent), lateConfirmations: late.map(presentIntent), recent: recent.map(presentIntent) } });
});

router.get('/payments/online/events', requirePermission('payments.reconcile'), async (req, res) => {
  const q = parse(pagination, req.query);
  const data = await MpesaEvent.find({ kind: { $in: ['gateway_webhook', 'gateway_verify'] } }).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean();
  res.json({ data });
});

/** Development only: set the outcome of a simulator payment, then run the normal verification path. */
router.post('/payments/gateways/simulate/:id', requirePermission('sales.create'), async (req, res) => {
  if (env().NODE_ENV === 'production') throw forbidden('Simulation is disabled in production');
  const body = parse(z.object({ status: z.enum(['succeeded', 'failed', 'cancelled']).default('succeeded'), amountCents: positiveCents.optional(), currency: z.string().length(3).optional() }), req.body ?? {});
  const i = await PaymentIntent.findById(idParam(req.params.id));
  if (!i?.reference || i.provider !== 'simulator') throw notFound('Simulator payment');
  SimulatorGateway.results.set(i.reference, {
    status: body.status, paidAmountCents: body.amountCents ?? i.amountCents, currency: body.currency ?? i.currency ?? undefined,
    receiptNumber: body.status === 'succeeded' ? `SIM${Date.now().toString(36).toUpperCase()}` : undefined, message: body.status === 'succeeded' ? 'Simulated payment' : `Simulated ${body.status}`,
  });
  await verifyGatewayIntent(i, false);
  res.json({ data: presentIntent((await PaymentIntent.findById(i._id).lean())!) });
});

export const gatewayRoutes = router;

// ---------------- webhooks (public; tenant from path + callback token, then provider authentication) ----------------

async function webhookTenant(req: Request) {
  const { tenantId, token, configId } = req.params as Record<string, string>;
  if (!/^[a-f0-9]{24}$/.test(tenantId) || !/^[a-f0-9]{24}$/.test(configId)) return null;
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant || !safeEqual(tenant.callbackToken, token)) return null;
  return tenant;
}

export async function handleGatewayWebhook(tenantId: Types.ObjectId, configId: string, input: { rawBody: Buffer; body: any; query: any; headers: Record<string, any>; ip: string }) {
  return runInTenant(tenantId, async () => {
    const cfg = await IntegrationConfig.findOne({ _id: configId, kind: 'payment' });
    if (!cfg) return 'unknown_config';
    const payload = { body: input.body, query: input.query };
    let keys;
    try {
      keys = paymentGatewayFor(cfg).webhook(input);
    } catch (err: any) {
      await logEvent('gateway_webhook', { provider: cfg.provider, configId: cfg._id, payload, ip: input.ip, outcome: 'error', error: err?.message });
      return 'error';
    }
    if (!keys) {
      await logEvent('gateway_webhook', { provider: cfg.provider, configId: cfg._id, payload, ip: input.ip, outcome: 'bad_signature' });
      return 'bad_signature';
    }
    const or = [
      ...(keys.reference ? [{ reference: keys.reference }] : []),
      ...(keys.providerRef ? [{ providerRef: keys.providerRef }] : []),
    ];
    const intent = or.length ? await PaymentIntent.findOne({ configId: cfg._id, $or: or }) : null;
    if (!intent) {
      await logEvent('gateway_webhook', { provider: cfg.provider, configId: cfg._id, payload, ip: input.ip, outcome: 'unknown_reference' });
      return 'unknown_reference';
    }
    await logEvent('gateway_webhook', { provider: cfg.provider, configId: cfg._id, payload, ip: input.ip, outcome: 'received', paymentIntentId: intent._id });
    return verifyGatewayIntent(intent, false);
  });
}

export const gatewayCallbackRoutes = Router();

gatewayCallbackRoutes.all('/:tenantId/:token/gw/:configId', async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  const tenant = await webhookTenant(req);
  if (!tenant) {
    // Unknown sender: acknowledge without detail so the URL cannot be probed.
    res.json({ received: true });
    return;
  }
  try {
    await handleGatewayWebhook(tenant._id, req.params.configId, {
      rawBody: (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), body: req.body ?? {}, query: req.query, headers: req.headers, ip: req.ip ?? '',
    });
  } catch (err) {
    logger.error({ err }, 'gateway webhook processing failed');
    res.status(500).json({ received: false });
    return;
  }
  // Pesapal expects its IPN echoed back; otherwise it keeps retrying.
  const q = { ...(req.query as Record<string, any>), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  if (q.OrderTrackingId) {
    res.json({ orderNotificationType: q.OrderNotificationType ?? 'IPNCHANGE', orderTrackingId: q.OrderTrackingId, orderMerchantReference: q.OrderMerchantReference, status: 200 });
    return;
  }
  res.json({ received: true });
});
