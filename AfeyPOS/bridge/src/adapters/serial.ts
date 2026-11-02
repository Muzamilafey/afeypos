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

/**
 * Parses common scale output lines, e.g. "ST,GS,+  1.250kg" (stable, gross), "ST,NT,+  1.000kg" (net),
 * "ST,TR,+  0.250kg" (tare), or a plain "  1.250 kg". Returns kg. Formats differ by model: test every scale.
 */
export function parseScaleFrame(frame: string): { weightKg: number; stable: boolean; kind?: 'gross' | 'net' | 'tare' } | null {
  const m = /([+-]?\s*\d+(?:\.\d+)?)\s*(kg|g|lb)?/i.exec(frame);
  if (!m) return null;
  let w = Number(m[1].replace(/\s/g, ''));
  if (!Number.isFinite(w)) return null;
  const unit = (m[2] ?? 'kg').toLowerCase();
  if (unit === 'g') w /= 1000;
  if (unit === 'lb') w *= 0.45359237;
  const stable = !/\bUS\b|unstable|MOTION|\bOL\b/i.test(frame);
  const tag = /\b(GS|NT|TR|G|N|T)\b/.exec(frame.toUpperCase())?.[1];
  const kind = tag === 'GS' || tag === 'G' ? 'gross' : tag === 'NT' || tag === 'N' ? 'net' : tag === 'TR' || tag === 'T' ? 'tare' : undefined;
  return { weightKg: Math.round(w * 1000) / 1000, stable, ...(kind ? { kind } : {}) };
}

export interface ScaleReadout { weightKg: number; stable: boolean; grossKg: number; tareKg: number; netKg: number; raw: string }

/** Combines the lines of one transmission (some scales send gross, tare and net on separate lines). */
export function combineScaleFrames(lines: string[]): ScaleReadout | null {
  const seen: Partial<Record<'gross' | 'net' | 'tare' | 'plain', number>> = {};
  let stable = true;
  let any = false;
  const raw: string[] = [];
  for (const l of lines) {
    const r = parseScaleFrame(l);
    if (!r) continue;
    any = true;
    raw.push(l.trim());
    stable = stable && r.stable;
    seen[r.kind ?? 'plain'] = r.weightKg;
  }
  if (!any) return null;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const tare = seen.tare ?? (seen.gross !== undefined && seen.net !== undefined ? round(seen.gross - seen.net) : 0);
  const gross = seen.gross ?? (seen.net !== undefined ? round(seen.net + tare) : seen.plain ?? 0);
  const net = seen.net ?? round((seen.plain ?? gross) - (seen.plain !== undefined ? 0 : tare));
  return { weightKg: net, stable, grossKg: gross, tareKg: tare, netKg: net, raw: raw.join(' | ').slice(0, 200) };
}

export async function readScale(cfg: SerialConfig, timeoutMs = 2000): Promise<ScaleReadout> {
  await configure(cfg);
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(devicePath(cfg.port));
    let buf = '';
    const t = setTimeout(() => { stream.destroy(); reject(new Error('Scale did not respond')); }, timeoutMs);
    stream.on('data', (chunk) => {
      buf += chunk.toString('ascii');
      const lines = buf.split(/\r?\n/);
      const r = combineScaleFrames(lines.slice(0, -1));
      if (r?.stable) { clearTimeout(t); stream.destroy(); resolve(r); return; }
      buf = lines[lines.length - 1];
    });
    stream.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
