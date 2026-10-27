import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown } from './helpers.js';
import { applyRecord } from '../src/modules/sync/apply.js';
import { specFor } from '../src/modules/sync/spec.js';
import { SyncConflict, UnitOfMeasure } from '../src/models/index.js';

beforeAll(async () => {
  await setupApp();
});
afterAll(teardown);

describe('replicating head-office records to a branch', () => {
  it('a unit the branch made itself with the same code gives way to head office’s', async () => {
    const tenantId = new Types.ObjectId();
    const coll = UnitOfMeasure.collection;
    await coll.insertOne({ _id: new Types.ObjectId(), tenantId, code: 'kg', name: 'Kilogram (local)', updatedAt: new Date() });
    const fromHq = { _id: new Types.ObjectId(), tenantId, code: 'kg', name: 'Kilogram', allowFractional: true, updatedAt: new Date() };
    const r = await applyRecord(specFor('unitofmeasures')!, fromHq, 'branch', 'MAIN');
    expect(r.outcome).toBe('applied');
    expect(await coll.find({ tenantId, code: 'kg' }).toArray()).toEqual([expect.objectContaining({ _id: fromHq._id, name: 'Kilogram' })]);
    expect(await SyncConflict.countDocuments({ collectionName: 'unitofmeasures' })).toBe(0);
  });

  it('head office still reports a clash in records a branch sends up', async () => {
    const tenantId = new Types.ObjectId();
    const coll = UnitOfMeasure.collection;
    await coll.insertOne({ _id: new Types.ObjectId(), tenantId, code: 'ctn', name: 'Carton', updatedAt: new Date() });
    const r = await applyRecord(specFor('unitofmeasures')!, { _id: new Types.ObjectId(), tenantId, code: 'ctn', name: 'Carton 2', updatedAt: new Date() }, 'hq', 'MAIN');
    expect(r.outcome).toBe('conflict');
  });
});
