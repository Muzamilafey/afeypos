import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { PrinterConfig } from '../config.js';

/** Sends raw ESC/POS (or ZPL/TSPL) bytes to a printer. */
export async function printRaw(cfg: PrinterConfig, data: Buffer): Promise<void> {
  if (cfg.type === 'network') {
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: cfg.host, port: cfg.port ?? 9100 });
      const t = setTimeout(() => { s.destroy(); reject(new Error('Printer timeout')); }, 5000);
      s.on('connect', () => s.end(data));
      s.on('close', () => { clearTimeout(t); resolve(); });
      s.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    return;
  }
  if (cfg.type === 'device') {
    // Linux: /dev/usb/lp0, Windows: \\.\COM3 or a mapped LPT port
    await fs.promises.writeFile(cfg.path, data);
    return;
  }
  if (cfg.type === 'system') {
    await printToSystemPrinter(cfg.name, data);
    return;
  }
  // Windows shared printer (Generic / Text Only driver): copy /b file \\localhost\SHARE
  if (process.platform !== 'win32') throw new Error('windows-share printing is only available on Windows');
  const tmp = path.join(os.tmpdir(), `afey-${Date.now()}.bin`);
  await fs.promises.writeFile(tmp, data);
  try {
    await new Promise<void>((resolve, reject) => execFile('cmd.exe', ['/c', 'copy', '/b', tmp, cfg.share], { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

const run = (cmd: string, args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const p = execFile(cmd, args, { windowsHide: true, maxBuffer: 4_000_000, timeout: 20_000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out))));
    if (input !== undefined) p.stdin?.end(input);
  });

/**
 * Raw bytes to a printer installed on this computer, without any print dialog. Windows: a RAW spooler job
 * through the winspool API (works with the printer's own driver or "Generic / Text Only"). Linux/macOS: CUPS.
 */
async function printToSystemPrinter(name: string, data: Buffer) {
  if (!/^[\w .()#&+,:/\\-]{1,120}$/.test(name)) throw new Error('Invalid printer name');
  const tmp = path.join(os.tmpdir(), `afey-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  await fs.promises.writeFile(tmp, data);
  try {
    if (process.platform === 'win32') {
      // The printer name and file are passed as arguments, never pasted into the script.
      const script = path.join(os.tmpdir(), 'afey-raw-print.ps1');
      await fs.promises.writeFile(script, WIN_RAW_PRINT);
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, name, tmp]);
    } else {
      await run('lp', ['-d', name, '-o', 'raw', tmp]);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const WIN_RAW_PRINT = `
param([string]$printer, [string]$file)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class AfeyRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int StartDocPrinter(IntPtr h, int l, DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Printer not found: " + printer);
    try {
      var di = new DOCINFO { pDocName = "Afey POS receipt", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("Cannot start the print job");
      StartPagePrinter(h); int w; WritePrinter(h, bytes, bytes.Length, out w); EndPagePrinter(h); EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
"@
[AfeyRaw]::Send($printer, [System.IO.File]::ReadAllBytes($file))
`;

/** Printers installed on this computer, for choosing the receipt printer in Afey POS. */
export async function listSystemPrinters(): Promise<{ name: string; default?: boolean; port?: string }[]> {
  try {
    if (process.platform === 'win32') {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Printer | Select-Object Name,Default,PortName | ConvertTo-Json -Compress']);
      const rows = out.trim() ? JSON.parse(out) : [];
      return (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({ name: r.Name, default: Boolean(r.Default), port: r.PortName }));
    }
    const out = await run('lpstat', ['-e']);
    const def = await run('lpstat', ['-d']).catch(() => '');
    const d = def.split(':')[1]?.trim();
    return out.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => ({ name, default: name === d }));
  } catch {
    return [];
  }
}

/** USB / serial receipt printers visible as devices (Linux: /dev/usb/lp0). */
export function listDevicePrinters(): string[] {
  if (process.platform === 'win32') return [];
  try {
    return fs.readdirSync('/dev/usb').filter((f) => f.startsWith('lp')).map((f) => `/dev/usb/${f}`);
  } catch {
    return [];
  }
}
