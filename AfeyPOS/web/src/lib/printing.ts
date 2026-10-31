/**
 * Receipt printing on this computer, following its print mode (Hardware > This computer: receipt printer).
 * Only "dialog" shows the browser's print window; the other modes send the receipt straight to the printer.
 */
import { api } from './api';
import { bridge } from './bridge';
import { getWorkstation } from './workstation';

export type PrintMode = 'dialog' | 'silent' | 'bridge' | 'network' | 'server';

export const PRINT_MODES: { value: PrintMode; label: string; help: string }[] = [
  { value: 'server', label: 'Printer on the Afey POS computer', help: 'Pick one of the printers installed on the computer running Afey POS. Receipts print by themselves, with no print window and no extra software. For shop installations.' },
  { value: 'bridge', label: 'Straight to the receipt printer (device bridge)', help: 'USB, network or installed printers through the Afey device bridge on this PC. No print window; opens the cash drawer on cash sales.' },
  { value: 'network', label: 'Network printer of this till (from the server)', help: 'The server sends ESC/POS to the printer set for this till under Hardware (IP address, port 9100). For local installations.' },
  { value: 'silent', label: 'Browser, without the print window (kiosk printing)', help: 'Prints the receipt page to the default printer at once. Needs Chrome or Edge started with --kiosk-printing (see below).' },
  { value: 'dialog', label: 'Browser print window', help: 'Shows the print window every time. Works with any printer, no setup.' },
];

export const printMode = (): PrintMode => getWorkstation().printMode ?? (getWorkstation().bridgeUrl ? 'bridge' : 'dialog');

/** Receipts print straight to a printer (no print window) in these modes. */
export const printsDirectly = () => ['bridge', 'network', 'server'].includes(printMode());

/** Prints an HTML page through a hidden frame (no pop-up window). With --kiosk-printing it prints silently. */
export async function printHtml(path: string) {
  const html = await api<Response>(path, { raw: true }).then((r) => r.text());
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    frame.srcdoc = html;
  });
  // Let images (logo, QR code, barcode) render first.
  await new Promise((r) => setTimeout(r, 150));
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
}

/**
 * Prints a sale receipt (kind "sale") or credit note (kind "return") the way this computer is set up.
 * Falls back to the print window if the direct route fails, so a receipt is never silently lost.
 */
export async function printReceipt(id: string, opts: { kind?: 'sale' | 'return'; tillId?: string; reprint?: boolean } = {}): Promise<'printer' | 'browser'> {
  const base = opts.kind === 'return' ? `/returns/${id}/receipt` : `/sales/${id}/receipt`;
  const w = getWorkstation();
  const mode = printMode();
  const width = w.receiptWidth ? `&width=${w.receiptWidth}` : '';
  try {
    if (mode === 'bridge') {
      const r = await api<{ data: { base64: string } }>(`${base}?format=escpos${width}`);
      await bridge('/print/raw', { printer: 'receipt', base64: r.data.base64 }, 20_000);
      return 'printer';
    }
    if (mode === 'server' && w.serverPrinter && opts.kind !== 'return') {
      await api(`/sales/${id}/print`, { body: { tillId: opts.tillId ?? w.tillId, reprint: Boolean(opts.reprint), localPrinter: w.serverPrinter, width: w.receiptWidth, openDrawer: w.openDrawerOnCash !== false } });
      return 'printer';
    }
    if (mode === 'network' && opts.kind !== 'return' && (opts.tillId ?? w.tillId)) {
      await api(`/sales/${id}/print`, { body: { tillId: opts.tillId ?? w.tillId, reprint: Boolean(opts.reprint) } });
      return 'printer';
    }
  } catch (e) {
    await printHtml(`${base}?format=html`);
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { fellBack: true });
  }
  await printHtml(`${base}?format=html`);
  return 'browser';
}
