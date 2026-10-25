/**
 * Fingerprint reader adapters. Vendor SDKs (ZKTeco ZKFinger SDK, SecuGen FDx SDK Pro) are Windows
 * libraries that must be licensed and installed separately. The bridge talks to them through a small
 * helper program (one per vendor, see bridge/helpers/) over a line-based JSON protocol on stdin/stdout:
 *
 *   → {"id":1,"cmd":"status"}                              ← {"id":1,"ok":true,"connected":true,"model":"ZK9500"}
 *   → {"id":2,"cmd":"capture","enroll":true}               ← {"id":2,"ok":true,"format":"zk-v10","template":"<base64>"}
 *   → {"id":3,"cmd":"match","candidate":{...},"stored":[...]}   ← {"id":3,"ok":true,"matched":true,"score":87}
 *   → {"id":4,"cmd":"identify","candidate":{...},"stored":[{"userId":"..",...}]} ← {"id":4,"ok":true,"userId":"..","score":91}
 *
 * Errors come back as {"id":n,"ok":false,"error":"Place your finger on the reader"}.
 * Only the simulator and the protocol itself are tested in this build; the vendor helpers are not.
 */
import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export interface CapturedTemplate {
  format: string;
  template: string; // base64 vendor template (never an image)
}

export interface StoredTemplate extends CapturedTemplate {
  userId?: string;
  finger?: string;
}

export interface FingerprintAdapter {
  readonly vendor: string;
  status(): Promise<{ connected: boolean; model?: string; message?: string }>;
  /** `enroll` asks the reader for its best-quality template (some SDKs merge three presses). */
  capture(opts?: { enroll?: boolean }): Promise<CapturedTemplate>;
  /** 1:1 match of a fresh capture against one user's stored templates. */
  match(candidate: CapturedTemplate, stored: StoredTemplate[]): Promise<{ matched: boolean; score: number }>;
  /** 1:N identification: which user (if any) the capture belongs to. */
  identify(candidate: CapturedTemplate, stored: StoredTemplate[]): Promise<{ userId: string | null; score: number }>;
}

/** Simulator for development and tests: "captures" a deterministic template from an env/test finger id. */
export class SimulatorAdapter implements FingerprintAdapter {
  readonly vendor = 'simulator';
  finger = process.env.AFEY_SIM_FINGER ?? 'finger-1';
  async status() {
    return { connected: true, model: 'Afey simulator', message: 'Simulated reader (no hardware)' };
  }
  async capture(): Promise<CapturedTemplate> {
    return { format: 'sim-v1', template: Buffer.from(crypto.createHash('sha256').update(this.finger).digest()).toString('base64') };
  }
  async match(candidate: CapturedTemplate, stored: StoredTemplate[]) {
    const matched = stored.some((s) => s.format === candidate.format && s.template === candidate.template);
    return { matched, score: matched ? 100 : 0 };
  }
  async identify(candidate: CapturedTemplate, stored: StoredTemplate[]) {
    const hit = stored.find((s) => s.format === candidate.format && s.template === candidate.template);
    return { userId: hit?.userId ?? null, score: hit ? 100 : 0 };
  }
}

class SdkNotInstalled implements FingerprintAdapter {
  constructor(readonly vendor: string, private sdk: string) {}
  async status() {
    return { connected: false, message: `${this.sdk} is not set up on this PC: install the SDK and set fingerprint.options.helperPath. See docs/BIOMETRICS.md.` };
  }
  async capture(): Promise<CapturedTemplate> {
    throw new Error(`${this.vendor} capture requires ${this.sdk}`);
  }
  async match(): Promise<{ matched: boolean; score: number }> {
    throw new Error(`${this.vendor} matching requires ${this.sdk}`);
  }
  async identify(): Promise<{ userId: string | null; score: number }> {
    throw new Error(`${this.vendor} matching requires ${this.sdk}`);
  }
}

export interface HelperOptions {
  /** Path to the vendor helper executable (e.g. C:\\AfeyBridge\\helpers\\zkfinger\\AfeyZkFinger.exe). */
  helperPath: string;
  args?: string[];
  /** How long to wait for a finger (ms). */
  captureTimeoutMs?: number;
}

/** Drives a vendor helper process over the JSON-lines protocol above; restarts it if it exits. */
export class HelperProcessAdapter implements FingerprintAdapter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private lastError = '';

  constructor(readonly vendor: string, private opts: HelperOptions) {}

  private start() {
    if (this.proc) return this.proc;
    const p = spawn(this.opts.helperPath, this.opts.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    p.on('error', (e) => {
      this.lastError = e.message;
      this.fail(new Error(`Fingerprint helper could not start: ${e.message}`));
    });
    p.on('exit', (code) => {
      this.proc = null;
      this.fail(new Error(`Fingerprint helper stopped (exit ${code ?? 'signal'})${this.lastError ? `: ${this.lastError}` : ''}`));
    });
    p.stderr.on('data', (d) => {
      this.lastError = String(d).trim().slice(-300);
    });
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // SDK chatter on stdout
      }
      const w = this.pending.get(msg.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.pending.delete(msg.id);
      if (msg.ok) w.resolve(msg);
      else w.reject(new Error(msg.error ?? 'Fingerprint reader error'));
    });
    this.proc = p;
    return p;
  }

  private fail(err: Error) {
    for (const [id, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
      this.pending.delete(id);
    }
  }

  private call<T = any>(cmd: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    const p = this.start();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(cmd === 'capture' ? 'No finger detected; try again' : 'Fingerprint reader did not answer'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      p.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  }

  async status() {
    try {
      const r = await this.call<{ connected: boolean; model?: string; message?: string }>('status', {}, 5000);
      return { connected: Boolean(r.connected), model: r.model, message: r.message };
    } catch (e: any) {
      return { connected: false, message: e.message };
    }
  }
  async capture(opts: { enroll?: boolean } = {}) {
    const r = await this.call<CapturedTemplate>('capture', { enroll: Boolean(opts.enroll) }, this.opts.captureTimeoutMs ?? 30_000);
    return { format: r.format, template: r.template };
  }
  async match(candidate: CapturedTemplate, stored: StoredTemplate[]) {
    const r = await this.call<{ matched: boolean; score: number }>('match', { candidate, stored });
    return { matched: Boolean(r.matched), score: Number(r.score ?? 0) };
  }
  async identify(candidate: CapturedTemplate, stored: StoredTemplate[]) {
    const r = await this.call<{ userId?: string | null; score: number }>('identify', { candidate, stored }, 20_000);
    return { userId: r.userId ?? null, score: Number(r.score ?? 0) };
  }
  stop() {
    this.proc?.kill();
  }
}

const SDK_NAMES: Record<string, string> = {
  zkteco: 'ZKTeco ZKFinger SDK (e.g. for ZK4500 / ZK9500 / SLK20R)',
  secugen: 'SecuGen FDx SDK Pro (e.g. for Hamster Pro 20)',
};

export function createFingerprintAdapter(vendor: string | undefined, options?: Record<string, unknown>): FingerprintAdapter {
  if (vendor === 'zkteco' || vendor === 'secugen' || vendor === 'helper') {
    const helperPath = typeof options?.helperPath === 'string' ? options.helperPath : '';
    if (!helperPath) return new SdkNotInstalled(vendor, SDK_NAMES[vendor] ?? 'a fingerprint helper program');
    return new HelperProcessAdapter(vendor, { helperPath, args: Array.isArray(options?.args) ? (options!.args as string[]) : undefined, captureTimeoutMs: typeof options?.captureTimeoutMs === 'number' ? options.captureTimeoutMs : undefined });
  }
  return new SimulatorAdapter();
}
