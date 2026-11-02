/**
 * Fiscal device monitor, run every few minutes by the scheduler for each business:
 *  - devices this server reaches itself (ETR program, folders, VSCU, simulators) get a cheap status check
 *    that never sends a fiscal command; KRA's online API (OSCU) is judged from the invoices actually sent;
 *  - when a device comes back, invoices waiting for it go at once;
 *  - invoices whose job was lost or gave up are queued again (sweepFiscalQueue).
 */
import { IntegrationConfig } from '../../models/index.js';
import { registerJob } from '../../jobs/queue.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { fiscalAdapter } from './adapters.js';
import { logFiscal, recordHealth } from './fiscal.js';
import { hurryFiscalQueue, sweepFiscalQueue } from './service.js';

export async function checkFiscalDevices() {
  const hq = env().DEPLOYMENT_MODE === 'hq';
  let back = false;
  for (const cfg of await IntegrationConfig.find({ kind: 'etims', enabled: true })) {
    const adapter = fiscalAdapter(cfg);
    // A device on a shop computer cannot be reached from the online head office.
    if (hq && adapter.getCapabilities().localOnly) continue;
    try {
      const st = await adapter.getStatus();
      const cameBack = await recordHealth(cfg._id, st.state === 'online', st.message, st.state);
      if (cameBack) {
        back = true;
        await logFiscal({ cfg, operation: 'health', ok: true, outcome: 'online', note: 'Device is back' });
      }
    } catch (err: any) {
      await recordHealth(cfg._id, false, String(err?.message ?? err));
    }
  }
  if (back) await hurryFiscalQueue();
  const requeued = await sweepFiscalQueue();
  if (requeued) logger.info({ requeued }, 'fiscal invoices queued again');
  return { requeued };
}

registerJob('fiscal.health', async () => {
  await checkFiscalDevices();
});
