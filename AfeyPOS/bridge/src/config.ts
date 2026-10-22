import fs from 'node:fs';
import path from 'node:path';

export type PrinterConfig =
  | { type: 'network'; host: string; port?: number }
  | { type: 'windows-share'; share: string }
  | { type: 'device'; path: string };

export interface SerialConfig {
  port: string;
  baud?: number;
  protocol?: 'cas' | 'toledo' | 'generic';
}

export interface BridgeConfig {
  port: number;
  host: string;
  allowedOrigins: string[];
  pairingToken: string;
  /** Local server address, or the tenant URL in the cloud (https://yourshop.afeypos.com). */
  server: { url: string };
  biometricDevice?: { deviceId: string; deviceKey: string };
  printers: Record<string, PrinterConfig>;
  display?: SerialConfig | null;
  scale?: SerialConfig | null;
  fingerprint?: { vendor: 'simulator' | 'zkteco' | 'secugen'; options?: Record<string, unknown> };
}

export function loadConfig(file = process.env.AFEY_BRIDGE_CONFIG ?? path.resolve('config.json')): BridgeConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BridgeConfig>;
  const cfg = { port: 9123, host: '127.0.0.1', allowedOrigins: [], printers: {}, ...raw } as BridgeConfig;
  if (!cfg.pairingToken || cfg.pairingToken.length < 24 || /REPLACE/.test(cfg.pairingToken)) throw new Error('Set a pairingToken of at least 24 random characters in config.json');
  if (!cfg.server?.url) throw new Error('Set server.url in config.json');
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') console.warn('[bridge] Listening on a non-loopback address exposes devices to the network.');
  return cfg;
}
