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
