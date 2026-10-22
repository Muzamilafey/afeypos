// Usage: npm run restore -w @afeypos/server -- <file.ndjson.gz> [--drop-existing] [--replace-tenant]
// Stop the Afey POS service before restoring a full backup.
import { withDb } from './cli.js';
import { restoreBackup, verifyBackupFile } from '../modules/backups/service.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Give the backup file to restore');
  process.exit(1);
}
if (!verifyBackupFile(file)) {
  console.error('Checksum file missing or does not match. Refusing to restore a possibly corrupted backup.');
  process.exit(2);
}
await withDb(async () => {
  const r = await restoreBackup(file, { dropExisting: process.argv.includes('--drop-existing'), replaceTenant: process.argv.includes('--replace-tenant') });
  console.log(`Restored ${r.documents} documents (${r.scope}${r.tenantId ? ' ' + r.tenantId : ''}).`);
});
