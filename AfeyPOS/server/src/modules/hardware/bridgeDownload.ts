/**
 * Everything a till PC needs to install the Afey device bridge, served by this Afey POS server itself, so a
 * till needs neither GitHub nor build tools: the installer script and the bridge, already built by this server's
 * own build. Nothing here is secret (the bridge is part of Afey POS); its pairing token is made on the till.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { AppError } from '../../lib/errors.js';

// <app>/server/(src|dist)/modules/hardware -> <app>
const appRoot = () => process.env.AFEY_APP_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The built bridge: dist/**\/*.js, package.json and the example config, as { relative path: text }. */
export function bridgeFiles(root = appRoot()): Record<string, string> {
  const base = path.join(root, 'bridge');
  const dist = path.join(base, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.js'))) {
    throw new AppError(404, 'BRIDGE_NOT_BUILT', 'The device bridge is not built on this server yet. Run the Afey POS upgrade (it builds the bridge), then try again.');
  }
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dist);
  for (const f of ['package.json', 'config.example.json']) {
    const p = path.join(base, f);
    if (fs.existsSync(p)) out[f] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

export const bridgeDownloadRoutes = Router();

bridgeDownloadRoutes.get('/install.ps1', (_req, res) => {
  const file = path.join(appRoot(), 'installer', 'windows', 'install-bridge.ps1');
  if (!fs.existsSync(file)) throw new AppError(404, 'BRIDGE_INSTALLER_MISSING', 'The bridge installer is missing on this server');
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

bridgeDownloadRoutes.get('/files', (_req, res) => {
  res.json({ files: bridgeFiles() });
});
