import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let rs: MongoMemoryReplSet;

export default async function setup(project: TestProject) {
  // Every test file has its own database: close idle WiredTiger file handles quickly so a full run stays well
  // under the open-files limit (mongod keeps them for 10 minutes by default and aborts at the limit).
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--wiredTigerEngineConfigString', 'file_manager=(close_idle_time=15,close_scan_interval=5,close_handle_minimum=250)'] }],
  });
  project.provide('mongoUri', rs.getUri());
  return async () => {
    await rs.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
