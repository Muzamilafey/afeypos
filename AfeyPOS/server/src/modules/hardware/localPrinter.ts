/**
 * Printers installed on the computer this server runs on. A shop installation runs the server on the counter PC,
 * so its own printers can be listed and printed to with no extra software: the till picks one and receipts go
 * straight to it. A cloud head office has no printers, so it offers none (tills there use the device bridge or
 * a network printer).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export interface LocalPrinter { name: string; isDefault: boolean; port?: string }

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4_000_000, timeout: 20_000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out))));
  });

/** Cloud head office: the server is in a data centre, so its printers are of no use to a till. */
export const serverHasPrinters = () => env().DEPLOYMENT_MODE !== 'hq';

/** Printers Windows, macOS or Linux has installed on this computer. */
export async function listLocalPrinters(): Promise<LocalPrinter[]> {
  try {
    if (process.platform === 'win32') {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Printer | Select-Object Name,Default,PortName | ConvertTo-Json -Compress']);
      const rows = out.trim() ? JSON.parse(out) : [];
      return (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map((r: any) => ({ name: String(r.Name), isDefault: Boolean(r.Default), port: r.PortName ? String(r.PortName) : undefined }));
    }
    const out = await run('lpstat', ['-e']);
    const def = (await run('lpstat', ['-d']).catch(() => '')).split(':')[1]?.trim();
    return out.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => ({ name, isDefault: name === def }));
  } catch {
    return [];
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

/**
 * Sends raw ESC/POS bytes to one of this computer's printers, with no print dialog: a RAW spooler job on
 * Windows (the printer's own driver or "Generic / Text Only"), CUPS elsewhere. The name is checked and passed
 * as an argument, never pasted into a command line.
 */
export async function printToLocalPrinter(name: string, data: Buffer): Promise<void> {
  if (!serverHasPrinters()) throw new AppError(409, 'NO_SERVER_PRINTERS', 'This is the online head-office server: it has no printers. Choose the till’s network printer or the device bridge instead.');
  if (!/^[\w .()#&+,:/\\-]{1,120}$/.test(name)) throw new AppError(400, 'BAD_PRINTER', 'That printer name cannot be used');
  const printers = await listLocalPrinters();
  if (!printers.some((p) => p.name === name)) throw new AppError(409, 'PRINTER_NOT_FOUND', `“${name}” is not installed on the Afey POS computer any more. Choose the printer again under Hardware → This computer.`);
  const tmp = path.join(os.tmpdir(), `afey-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  await fs.promises.writeFile(tmp, data);
  try {
    if (process.platform === 'win32') {
      const script = path.join(os.tmpdir(), 'afey-raw-print.ps1');
      await fs.promises.writeFile(script, WIN_RAW_PRINT);
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, name, tmp]);
    } else {
      await run('lp', ['-d', name, '-o', 'raw', tmp]);
    }
  } catch (err: any) {
    throw new AppError(502, 'PRINT_FAILED', `The printer refused the job: ${String(err?.message ?? err).slice(0, 200)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
