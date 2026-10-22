import { defineConfig } from 'vitest/config';
import fs from 'node:fs';

// In restricted environments point mongodb-memory-server at a pre-installed mongod (see docs/TESTING.md).
const systemBinary = process.env.MONGOMS_SYSTEM_BINARY ?? (fs.existsSync('/opt/mongo/mongod-wrapper') ? '/opt/mongo/mongod-wrapper' : undefined);

if (systemBinary) {
  process.env.MONGOMS_SYSTEM_BINARY = systemBinary;
  process.env.MONGOMS_VERSION ??= '7.0.34';
}

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: true,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...(systemBinary ? { MONGOMS_SYSTEM_BINARY: systemBinary } : {}),
    },
  },
});
