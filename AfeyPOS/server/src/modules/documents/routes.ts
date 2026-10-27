/**
 * PDF downloads and "email with PDF" for business documents:
 *   GET  /pdf/:kind/:id    supplier_quotation | purchase_order | goods_receipt | quotation | invoice
 *   GET  /print/:kind/:id  the same document as a print page (HTML)
 *   POST /email/:kind/:id  { to?, cc?, message? }  (defaults to the supplier's or customer's email)
 *   POST /render/report?format=pdf|html  a report the page shows, on the business letterhead
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { Permission } from '@afeypos/shared';
import { Sale, User } from '../../models/index.js';
import { idParam, parse } from '../../http/validate.js';
import { can, markGuard, requireAnyPermission } from '../../http/auth.js';
import { forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../notifications/service.js';
import { buildDocument, buildDocumentSpec, businessOf, DOCUMENT_KINDS, type DocumentKind } from './builders.js';
import { renderDocumentHtml, renderReportHtml, renderReportPdf, reportSpecSchema } from './report.js';

const READ: Record<DocumentKind, { perm: Permission; module: string }> = {
  supplier_quotation: { perm: 'purchasing.read', module: 'purchasing' },
  purchase_order: { perm: 'purchasing.read', module: 'purchasing' },
  goods_receipt: { perm: 'purchasing.read', module: 'purchasing' },
  quotation: { perm: 'sales.read', module: 'pos' },
  invoice: { perm: 'sales.read', module: 'pos' },
};
const SEND: Record<DocumentKind, Permission> = {
  supplier_quotation: 'purchasing.manage', purchase_order: 'purchasing.manage', goods_receipt: 'purchasing.read', quotation: 'quotations.manage', invoice: 'sales.read',
};

function kindOf(req: Request): DocumentKind {
  const kind = String(req.params.kind) as DocumentKind;
  if (!DOCUMENT_KINDS.includes(kind)) throw notFound('Document type');
  return kind;
}

async function checkAccess(req: Request, kind: DocumentKind, id: unknown, perm: Permission) {
  if (!can(req, perm)) throw forbidden('You do not have permission for this document');
  if (!req.capabilities!.modules.includes(READ[kind].module as any)) throw unprocessable('This module is not enabled', 'MODULE_DISABLED');
  // Cashiers without "all sales" only see their own sales.
  if (kind === 'invoice' && !can(req, 'sales.read.all') && !(await Sale.exists({ _id: id, cashierId: req.auth!.userId }))) throw notFound('Sale');
}

/** Queues an email with the document's PDF attached. Used here and when sending RFQs and purchase orders. */
export async function emailDocument(req: Request, kind: DocumentKind, id: unknown, opts: { to?: string; cc?: string[]; message?: string; templateKey?: string; data?: Record<string, unknown> } = {}): Promise<{ queued: boolean; reason?: string; to?: string }> {
  if (!req.capabilities!.modules.includes('email')) return { queued: false, reason: 'The email module is not enabled' };
  const doc = await buildDocument(req.tenant!._id, kind, id);
  const to = opts.to || doc.recipient.email;
  if (!to) return { queued: false, reason: `${doc.recipient.name} has no email address` };
  const me = await User.findById(req.auth!.userId, { name: 1 }).lean();
  const t = req.tenant!;
  const contact = [t.contact?.phone, t.contact?.email].filter(Boolean).join(' | ');
  const r = await notify({
    channel: 'email', to, cc: opts.cc, templateKey: opts.templateKey ?? 'document', attachment: { kind, id: String(id) }, ref: { type: kind, id: id as any },
    dedupeKey: `doc:${kind}:${id}:${to}:${Date.now()}`,
    data: { business: t.name, recipient: doc.recipient.name, title: doc.title.toLowerCase(), number: doc.number, message: opts.message || 'Thank you for your business.', sender: me?.name ?? '', contact: contact ? `\n${contact}` : '', amountLine: '', ...opts.data },
  });
  return { ...r, to };
}

const router = Router();

/** Access depends on the document type (purchasing vs sales permissions), checked per request. */
const readGuard = markGuard(async (req, _res, next) => {
  await checkAccess(req, kindOf(req), idParam(req.params.id), READ[kindOf(req)].perm);
  next();
}, 'document read permission by type');
const sendGuard = markGuard(async (req, _res, next) => {
  await checkAccess(req, kindOf(req), idParam(req.params.id), SEND[kindOf(req)]);
  next();
}, 'document send permission by type');

router.get('/pdf/:kind/:id', readGuard, async (req, res) => {
  const kind = kindOf(req);
  const id = idParam(req.params.id);
  const doc = await buildDocument(req.tenant!._id, kind, id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${doc.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(doc.buffer);
});

router.get('/print/:kind/:id', readGuard, async (req, res) => {
  const { spec } = await buildDocumentSpec(req.tenant!._id, kindOf(req), idParam(req.params.id));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(renderDocumentHtml(spec));
});

/**
 * Reports are built from what the page already loaded (and was allowed to load), so this only lays them out:
 * anyone who can read some report may use it.
 */
router.post('/render/report', requireAnyPermission('reports.read', 'accounting.read', 'inventory.read', 'audit.read', 'hr.manage', 'payments.reconcile', 'purchasing.read', 'sales.read.all'), async (req, res) => {
  const format = req.query.format === 'html' ? 'html' : 'pdf';
  const spec = parse(reportSpecSchema, req.body ?? {});
  const { business, tenant } = await businessOf(req.tenant!._id);
  const me = await User.findById(req.auth!.userId, { name: 1 }).lean();
  const generatedAt = new Date().toLocaleString('en-KE', { timeZone: tenant.settings?.timezone ?? 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ctx = { business, generatedBy: me?.name ?? 'staff', generatedAt };
  res.setHeader('Cache-Control', 'private, no-store');
  if (format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderReportHtml(spec, ctx));
    return;
  }
  const name = `${spec.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(await renderReportPdf(spec, ctx));
});

router.post('/email/:kind/:id', sendGuard, async (req, res) => {
  const kind = kindOf(req);
  const id = idParam(req.params.id);
  const body = parse(z.object({ to: z.string().trim().email().optional().or(z.literal('')), cc: z.array(z.string().trim().email()).max(5).default([]), message: z.string().trim().max(2000).optional() }), req.body ?? {});
  const r = await emailDocument(req, kind, id, { to: body.to || undefined, cc: body.cc, message: body.message });
  if (!r.queued) throw unprocessable(`Email not sent: ${r.reason}`, 'EMAIL_NOT_SENT');
  await audit(req, { action: 'document.emailed', entity: kind, entityId: id, details: { to: r.to, cc: body.cc } });
  res.json({ data: { queued: true, to: r.to } });
});

export const documentPdfRoutes = router;
