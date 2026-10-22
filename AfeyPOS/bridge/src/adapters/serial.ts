import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { SerialConfig } from '../config.js';

/**
 * Minimal serial access without native modules: on Windows COM ports are opened as files after
 * configuring them with `mode`; on Linux use /dev/ttyUSB0 configured with `stty`.
 * Verified only for write-style devices in development; test with your hardware before relying on it.
 */
async function configure(cfg: SerialConfig) {
  const baud = String(cfg.baud ?? 9600);
  await new Promise<void>((resolve) => {
    if (process.platform === 'win32') execFile('mode', [cfg.port, `BAUD=${baud}`, 'PARITY=n', 'DATA=8', 'STOP=1'], { shell: true, windowsHide: true }, () => resolve());
    else execFile('stty', ['-F', cfg.port, baud, 'raw', '-echo'], () => resolve());
  });
}

function devicePath(port: string) {
  return process.platform === 'win32' && /^COM\d+$/i.test(port) ? `\\\\.\\${port}` : port;
}

export async function writeSerial(cfg: SerialConfig, data: Buffer) {
  await configure(cfg);
  await fs.promises.writeFile(devicePath(cfg.port), data);
}

/** Two-line VFD/LCD pole display (20 chars per line, ESC/POS-compatible "clear + home"). */
export function displayFrame(line1: string, line2: string): Buffer {
  const clip = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').slice(0, 20).padEnd(20);
  return Buffer.concat([Buffer.from([0x0c]), Buffer.from(clip(line1) + clip(line2), 'ascii')]);
}

/** Parses common scale output frames, e.g. "ST,GS,+  1.250kg" (CAS) or "  1.250 kg" (generic). Returns kg. */
export function parseScaleFrame(frame: string): { weightKg: number; stable: boolean } | null {
  const m = /([+-]?\s*\d+(?:\.\d+)?)\s*(kg|g|lb)?/i.exec(frame);
  if (!m) return null;
  let w = Number(m[1].replace(/\s/g, ''));
  const unit = (m[2] ?? 'kg').toLowerCase();
  if (unit === 'g') w /= 1000;
  if (unit === 'lb') w *= 0.45359237;
  const stable = !/\bUS\b|unstable|MOTION/i.test(frame);
  return { weightKg: Math.round(w * 1000) / 1000, stable };
}

export async function readScale(cfg: SerialConfig, timeoutMs = 2000): Promise<{ weightKg: number; stable: boolean }> {
  await configure(cfg);
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(devicePath(cfg.port));
    let buf = '';
    const t = setTimeout(() => { stream.destroy(); reject(new Error('Scale did not respond')); }, timeoutMs);
    stream.on('data', (chunk) => {
      buf += chunk.toString('ascii');
      const lines = buf.split(/\r?\n/);
      for (const l of lines.slice(0, -1)) {
        const r = parseScaleFrame(l);
        if (r?.stable) { clearTimeout(t); stream.destroy(); resolve(r); return; }
      }
      buf = lines[lines.length - 1];
    });
    stream.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
