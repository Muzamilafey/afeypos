import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let rs: MongoMemoryReplSet;

export default async function setup(project: TestProject) {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
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
