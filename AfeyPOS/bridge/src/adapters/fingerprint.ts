/**
 * Fingerprint reader adapters. Vendor SDKs (ZKTeco ZKFinger SDK, SecuGen FDx SDK Pro) are Windows
 * libraries that must be licensed and installed separately; this bridge loads them through a small
 * helper process (see docs/BIOMETRICS.md). Only the simulator is implemented and tested here.
 */
import crypto from 'node:crypto';

export interface CapturedTemplate {
  format: string;
  template: string; // base64 vendor template (never an image)
}

export interface FingerprintAdapter {
  readonly vendor: string;
  status(): Promise<{ connected: boolean; model?: string; message?: string }>;
  capture(): Promise<CapturedTemplate>;
  /** 1:1 match of a fresh capture against stored templates. */
  match(candidate: CapturedTemplate, stored: CapturedTemplate[]): Promise<{ matched: boolean; score: number }>;
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
  async match(candidate: CapturedTemplate, stored: CapturedTemplate[]) {
    const matched = stored.some((s) => s.format === candidate.format && s.template === candidate.template);
    return { matched, score: matched ? 100 : 0 };
  }
}

class SdkNotInstalled implements FingerprintAdapter {
  constructor(readonly vendor: string, private sdk: string) {}
  async status() {
    return { connected: false, message: `${this.sdk} is not installed or not licensed on this PC. See docs/BIOMETRICS.md.` };
  }
  async capture(): Promise<CapturedTemplate> {
    throw new Error(`${this.vendor} capture requires ${this.sdk}`);
  }
  async match(): Promise<{ matched: boolean; score: number }> {
    throw new Error(`${this.vendor} matching requires ${this.sdk}`);
  }
}

export function createFingerprintAdapter(vendor: string | undefined): FingerprintAdapter {
  if (vendor === 'zkteco') return new SdkNotInstalled('zkteco', 'ZKTeco ZKFinger SDK (e.g. for ZK4500 / SLK20R)');
  if (vendor === 'secugen') return new SdkNotInstalled('secugen', 'SecuGen FDx SDK Pro (e.g. for Hamster Pro 20)');
  return new SimulatorAdapter();
}
