// Usage: npm run backup -w @afeypos/server [-- --tenant <tenantId>] [-- --dir <path>]
import { Types } from 'mongoose';
import { withDb } from './cli.js';
import { createBackup, pruneBackups } from '../modules/backups/service.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

await withDb(async () => {
  const tenant = arg('tenant');
  const r = await createBackup({ scope: tenant ? 'tenant' : 'full', tenantId: tenant ? new Types.ObjectId(tenant) : undefined, dir: arg('dir') });
  console.log(`Backup written: ${r.file}\n  documents: ${r.documents}\n  size: ${(r.sizeBytes / 1048576).toFixed(2)} MB\n  sha256: ${r.sha256}`);
  if (!tenant) console.log(`Pruned ${await pruneBackups(arg('dir'))} old backups`);
});
