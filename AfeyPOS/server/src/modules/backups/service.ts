/**
 * Application-level backups: gzip-compressed NDJSON of MongoDB Extended JSON (lossless types),
 * with a SHA-256 checksum. Works for a full installation (local) or a single tenant (cloud export).
 * For large cloud deployments use MongoDB Atlas / mongodump snapshots in addition (docs/BACKUP.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import mongoose, { Types } from 'mongoose';
import { BackupRecord } from '../../models/index.js';
import { env } from '../../config/env.js';

const { EJSON } = mongoose.mongo.BSON;
const SKIP_FULL = new Set(['sessions', 'authtokens', 'idempotencyrecords']);
const FORMAT = 'afeypos-backup-v1';

/** Collections whose documents carry tenantId (plugin-scoped models plus optional-tenant logs). */
function tenantCollections(): string[] {
  const names = new Set<string>();
  for (const m of Object.values(mongoose.models)) {
    if (m.schema.path('tenantId') && m.modelName !== 'BackupRecord' && m.modelName !== 'SupportGrant') names.add(m.collection.collectionName);
  }
  for (const s of SKIP_FULL) names.delete(s);
  return [...names];
}

export interface BackupResult {
  file: string;
  sha256: string;
  documents: number;
  sizeBytes: number;
}

export async function createBackup(opts: { scope: 'full' | 'tenant'; tenantId?: Types.ObjectId; dir?: string; trigger?: 'manual' | 'scheduled' }): Promise<BackupResult & { id: Types.ObjectId }> {
  const dir = path.resolve(opts.dir ?? env().BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `afeypos-${opts.scope}${opts.tenantId ? '-' + opts.tenantId : ''}-${stamp}.ndjson.gz`);
  const record = await BackupRecord.create({ scope: opts.scope, tenantId: opts.tenantId, file, trigger: opts.trigger ?? 'manual' });
  try {
    const db = mongoose.connection.db!;
    const collections = opts.scope === 'full' ? (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !SKIP_FULL.has(n) && !n.startsWith('system.')) : tenantCollections();
    let documents = 0;
    async function* lines() {
      yield JSON.stringify({ format: FORMAT, scope: opts.scope, tenantId: opts.tenantId ? String(opts.tenantId) : null, createdAt: new Date().toISOString(), collections }) + '\n';
      if (opts.scope === 'tenant') {
        const t = await db.collection('tenants').findOne({ _id: opts.tenantId });
        if (t) {
          documents++;
          yield JSON.stringify({ c: 'tenants', d: EJSON.serialize(t, { relaxed: false }) }) + '\n';
        }
      }
      for (const c of collections) {
        const filter = opts.scope === 'tenant' ? { tenantId: opts.tenantId } : {};
        for await (const doc of db.collection(c).find(filter)) {
          documents++;
          yield JSON.stringify({ c, d: EJSON.serialize(doc, { relaxed: false }) }) + '\n';
        }
      }
    }
    const hash = crypto.createHash('sha256');
    const gz = zlib.createGzip();
    const out = fs.createWriteStream(file);
    gz.on('data', (chunk) => hash.update(chunk));
    await pipeline(Readable.from(lines()), gz, out);
    const sha256 = hash.digest('hex');
    fs.writeFileSync(file + '.sha256', `${sha256}  ${path.basename(file)}\n`);
    const sizeBytes = fs.statSync(file).size;
    await BackupRecord.updateOne({ _id: record._id }, { $set: { status: 'completed', completedAt: new Date(), sha256, sizeBytes, documents } });
    return { id: record._id, file, sha256, documents, sizeBytes };
  } catch (err: any) {
    await BackupRecord.updateOne({ _id: record._id }, { $set: { status: 'failed', error: String(err?.message ?? err), completedAt: new Date() } });
    throw err;
  }
}

export function verifyBackupFile(file: string): boolean {
  const sidecar = file + '.sha256';
  if (!fs.existsSync(sidecar)) return false;
  const expected = fs.readFileSync(sidecar, 'utf8').split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return expected === actual;
}

export interface RestoreOptions {
  /** full: target database must be empty unless dropExisting. tenant: tenant must not exist unless replaceTenant. */
  dropExisting?: boolean;
  replaceTenant?: boolean;
  skipChecksum?: boolean;
}

export async function restoreBackup(file: string, opts: RestoreOptions = {}): Promise<{ scope: string; documents: number; tenantId: string | null }> {
  if (!opts.skipChecksum && !verifyBackupFile(file)) throw new Error('Backup checksum missing or does not match; refusing to restore');
  const db = mongoose.connection.db!;
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let header: { format: string; scope: 'full' | 'tenant'; tenantId: string | null; collections: string[] } | null = null;
  let documents = 0;
  const batch = new Map<string, unknown[]>();
  const flush = async (c?: string) => {
    for (const [name, docs] of batch) {
      if (c && name !== c) continue;
      if (docs.length) await db.collection(name).insertMany(docs as any[], { ordered: false });
      batch.set(name, []);
    }
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (!header) {
      if (obj.format !== FORMAT) throw new Error('Not an Afey POS backup file');
      header = obj;
      if (header!.scope === 'full') {
        const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
        const nonEmpty = [];
        for (const n of existing) if (await db.collection(n).estimatedDocumentCount()) nonEmpty.push(n);
        if (nonEmpty.length && !opts.dropExisting) throw new Error(`Target database is not empty (${nonEmpty.join(', ')}); pass dropExisting to overwrite`);
        if (opts.dropExisting) for (const n of existing) if (!n.startsWith('system.')) await db.collection(n).deleteMany({});
      } else {
        const tid = new Types.ObjectId(header!.tenantId!);
        const exists = await db.collection('tenants').findOne({ _id: tid });
        if (exists && !opts.replaceTenant) throw new Error('Tenant already exists; pass replaceTenant to overwrite its data');
        // Remove the tenant document (if replacing) and any orphaned documents of this tenant so the restore is exact.
        await db.collection('tenants').deleteOne({ _id: tid });
        for (const c of header!.collections) await db.collection(c).deleteMany({ tenantId: tid });
      }
      continue;
    }
    const doc = EJSON.deserialize(obj.d);
    const list = batch.get(obj.c) ?? [];
    list.push(doc);
    batch.set(obj.c, list);
    documents++;
    if (list.length >= 500) await flush(obj.c);
  }
  await flush();
  if (!header) throw new Error('Empty backup file');
  // Rebuild indexes defined by the application.
  for (const m of Object.values(mongoose.models)) await m.syncIndexes().catch(() => undefined);
  return { scope: header.scope, documents, tenantId: header.tenantId };
}

export async function pruneBackups(dir = env().BACKUP_DIR, keep = env().BACKUP_RETENTION) {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('afeypos-full-') && f.endsWith('.ndjson.gz')).sort().reverse();
  let removed = 0;
  for (const f of files.slice(keep)) {
    fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, f + '.sha256'), { force: true });
    removed++;
  }
  return removed;
}
