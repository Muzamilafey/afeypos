import { Router } from 'express';
import net from 'node:net';
import { z } from 'zod';
import { HardwareDevice, Sale, Till, Tenant } from '../../models/index.js';
import { idParam, objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { listLocalPrinters, printToLocalPrinter, serverHasPrinters } from './localPrinter.js';
import { audit } from '../../lib/audit.js';
import { runAsPlatform } from '../../lib/context.js';
import { env } from '../../config/env.js';
import { receiptContext, renderReceiptEscPos, renderReceiptHtml, renderReceiptText, testSlipEscPos } from './receipt.js';
import { EscPosBuilder } from './escpos.js';

const router = Router();

const KINDS = ['receipt_printer', 'label_printer', 'a4_printer', 'cash_drawer', 'customer_display', 'scale', 'barcode_scanner', 'rfid_reader', 'fingerprint_reader'] as const;

const deviceSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string().trim().min(2).max(80),
  branchId: objectId.optional(),
  tillId: objectId.optional(),
  connection: z.enum(['network', 'usb', 'serial', 'bluetooth', 'bridge', 'browser', 'keyboard_wedge']),
  settings: z.object({
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    width: z.number().int().min(24).max(64).optional(),
    bridgeUrl: z.string().url().optional(),
    printerName: z.string().max(120).optional(),
    serialPort: z.string().max(60).optional(),
    baudRate: z.number().int().optional(),
    openDrawerOnCash: z.boolean().optional(),
    labelLanguage: z.enum(['zpl', 'tspl', 'browser']).optional(),
  }).passthrough().default({}),
  active: z.boolean().default(true),
});

/** Sends raw bytes to a network (port 9100 / JetDirect) printer from the server. LAN/local installations only. */
export function sendRaw(host: string, port: number, data: Buffer, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Printer ${host}:${port} did not respond`));
    }, timeoutMs);
    sock.on('connect', () => sock.end(data));
    sock.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function assertNetworkPrintingAllowed(host: string) {
  // The online HQ server must not connect to hosts on its own network on users' behalf (SSRF); print via the browser or the till's bridge.
  if (env().DEPLOYMENT_MODE === 'hq') throw new AppError(400, 'USE_BRIDGE', 'The head-office server prints through the browser or the Afey device bridge on the till PC');
  if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost$)/.test(host)) throw badRequest('Network printers must be on the local network');
}

router.get('/hardware/devices', requirePermission('hardware.manage'), async (_req, res) => {
  res.json({ data: await HardwareDevice.find({}).sort({ kind: 1, name: 1 }).lean() });
});

router.post('/hardware/devices', requirePermission('hardware.manage'), async (req, res) => {
  const body = parse(deviceSchema, req.body);
  const d = await HardwareDevice.create(body);
  await audit(req, { action: 'hardware.device_added', entity: 'HardwareDevice', entityId: d._id, details: { kind: d.kind } });
  res.status(201).json({ data: d });
});

router.patch('/hardware/devices/:id', requirePermission('hardware.manage'), async (req, res) => {
  const body = parse(deviceSchema.partial(), req.body);
  const d = await HardwareDevice.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: body }, { new: true });
  if (!d) throw notFound('Device');
  res.json({ data: d });
});

router.delete('/hardware/devices/:id', requirePermission('hardware.manage'), async (req, res) => {
  await HardwareDevice.deleteOne({ _id: idParam(req.params.id) });
  res.json({ ok: true });
});

/** Connection test: TCP reachability + test page for network printers; other connections are tested from the browser/bridge. */
router.post('/hardware/devices/:id/test', requirePermission('hardware.manage'), async (req, res) => {
  const d = await HardwareDevice.findById(idParam(req.params.id));
  if (!d) throw notFound('Device');
  let ok = false;
  let message: string;
  if (d.connection === 'network' && d.settings?.host) {
    try {
      assertNetworkPrintingAllowed(d.settings.host);
      const page = new EscPosBuilder(d.settings.width ?? 42).align('center').bold(true).line('Afey POS test page').bold(false).line(new Date().toISOString()).feed(3).cut().build();
      await sendRaw(d.settings.host, d.settings.port ?? 9100, d.kind === 'receipt_printer' ? page : Buffer.alloc(0));
      ok = true;
      message = 'Printer reachable; test page sent';
    } catch (e: any) {
      message = e.message;
    }
  } else {
    message = `${d.connection} devices are tested from the till (browser or Afey device bridge)`;
    ok = true;
  }
  d.status = { lastCheckAt: new Date(), ok, message } as any;
  await d.save();
  res.json({ data: { ok, message } });
});

/** Receipt in text, HTML (browser printing) or ESC/POS (base64, for the bridge) formats. */
router.get('/sales/:id/receipt', requirePermission('sales.read'), async (req, res) => {
  const { format, width } = parse(z.object({ format: z.enum(['html', 'text', 'escpos']).default('html'), width: z.coerce.number().int().min(24).max(64).optional() }), req.query);
  const sale = await Sale.findById(idParam(req.params.id)).lean();
  if (!sale) throw notFound('Sale');
  const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const ctx = await receiptContext(tenant as any, sale);
  if (format === 'html') {
    res.type('html').send(renderReceiptHtml(tenant as any, sale as any, ctx));
  } else if (format === 'text') {
    res.type('text').send(renderReceiptText(tenant as any, sale as any, { ...ctx, width }));
  } else {
    const openDrawer = sale.payments.some((p) => p.method === 'cash');
    res.json({ data: { base64: renderReceiptEscPos(tenant as any, sale as any, { ...ctx, width, openDrawer }).toString('base64') } });
  }
});

/** Server-side printing to the till's network receipt printer (local installations). */
/** Prints a receipt from the server: to a printer installed on this computer, or to the till's network printer. */
router.post('/sales/:id/print', requirePermission('sales.read'), async (req, res) => {
  const body = parse(z.object({ tillId: objectId.optional(), reprint: z.boolean().default(false), localPrinter: z.string().trim().max(120).optional(), width: z.number().int().min(24).max(96).optional(), openDrawer: z.boolean().optional() }), req.body);
  const sale = await Sale.findById(idParam(req.params.id)).lean();
  if (!sale) throw notFound('Sale');
  const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const ctx = await receiptContext(tenant as any, sale);
  const cash = sale.payments.some((p) => p.method === 'cash');
  if (body.localPrinter) {
    const bytes = renderReceiptEscPos(tenant as any, sale as any, { ...ctx, reprint: body.reprint, width: body.width, openDrawer: !body.reprint && body.openDrawer !== false && cash });
    await printToLocalPrinter(body.localPrinter, bytes);
    if (body.reprint) await audit(req, { action: 'sale.receipt_reprinted', entity: 'Sale', entityId: sale._id });
    res.json({ ok: true, printer: body.localPrinter });
    return;
  }
  if (!body.tillId) throw badRequest('Choose the till, or a printer on this computer');
  const till = await Till.findById(body.tillId).lean();
  const printer = till?.receiptPrinterId ? await HardwareDevice.findById(till.receiptPrinterId).lean() : await HardwareDevice.findOne({ kind: 'receipt_printer', tillId: body.tillId, active: true }).lean();
  if (!printer || printer.connection !== 'network' || !printer.settings?.host) throw new AppError(409, 'NO_NETWORK_PRINTER', 'No network receipt printer is configured for this till; use browser printing');
  assertNetworkPrintingAllowed(printer.settings.host);
  const bytes = renderReceiptEscPos(tenant as any, sale as any, { ...ctx, reprint: body.reprint, width: printer.settings.width ?? undefined, openDrawer: !body.reprint && printer.settings.openDrawerOnCash !== false && cash });
  await sendRaw(printer.settings.host, printer.settings.port ?? 9100, bytes);
  if (body.reprint) await audit(req, { action: 'sale.receipt_reprinted', entity: 'Sale', entityId: sale._id });
  res.json({ ok: true });
});

/** The printers installed on the computer Afey POS runs on, for a till to choose from. */
router.get('/hardware/printers/local', requirePermission('sales.create'), async (_req, res) => {
  if (!serverHasPrinters()) {
    res.json({ data: { available: false, reason: 'This is the online head-office server, which has no printers. Use the till’s network printer or the Afey device bridge.', printers: [] } });
    return;
  }
  const printers = await listLocalPrinters();
  res.json({ data: { available: true, ...(printers.length ? {} : { reason: 'No printer is installed on the Afey POS computer yet. Install the receipt printer in Windows (or CUPS), then look again.' }), printers } });
});

/** Prints a test slip so the cashier can see the chosen printer works, and the drawer opens. */
router.post('/hardware/printers/local/test', requirePermission('sales.create'), async (req, res) => {
  const body = parse(z.object({ printer: z.string().trim().min(1).max(120), width: z.number().int().min(24).max(96).optional(), openDrawer: z.boolean().default(false) }), req.body);
  const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  await printToLocalPrinter(body.printer, testSlipEscPos(tenant?.name ?? 'Afey POS', body.printer, body.width ?? 32, body.openDrawer));
  await audit(req, { action: 'hardware.printer_tested', details: { printer: body.printer } });
  res.json({ ok: true });
});

/** Label data in ZPL or TSPL for label printers (browser labels are rendered client-side). */
router.post('/hardware/labels', requirePermission('products.read'), async (req, res) => {
  const body = parse(z.object({ language: z.enum(['zpl', 'tspl']), items: z.array(z.object({ name: z.string().max(60), price: z.string().max(20), barcode: z.string().regex(/^[A-Za-z0-9-]{1,40}$/), copies: z.number().int().min(1).max(500).default(1) })).min(1).max(500) }), req.body);
  const clean = (s: string) => s.replace(/[\^~"\\]/g, '');
  const out = body.items.map((i) =>
    body.language === 'zpl'
      ? `^XA^CI28^FO20,20^A0N,28,28^FD${clean(i.name)}^FS^FO20,60^A0N,36,36^FD${clean(i.price)}^FS^FO20,110^BY2^BCN,60,Y,N,N^FD${i.barcode}^FS^PQ${i.copies}^XZ`
      : `SIZE 50 mm,30 mm\nGAP 2 mm,0\nCLS\nTEXT 20,10,"3",0,1,1,"${clean(i.name)}"\nTEXT 20,45,"4",0,1,1,"${clean(i.price)}"\nBARCODE 20,90,"128",60,1,0,2,2,"${i.barcode}"\nPRINT ${i.copies}\n`,
  );
  res.json({ data: { language: body.language, payload: out.join('\n') } });
});

export const hardwareRoutes = router;
