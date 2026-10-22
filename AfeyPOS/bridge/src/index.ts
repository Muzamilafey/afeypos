import { loadConfig } from './config.js';
import { createBridgeServer } from './server.js';

const cfg = loadConfig();
createBridgeServer(cfg).listen(cfg.port, cfg.host, () => {
  console.log(`[afey-bridge] listening on http://${cfg.host}:${cfg.port} (fingerprint: ${cfg.fingerprint?.vendor ?? 'simulator'})`);
});
