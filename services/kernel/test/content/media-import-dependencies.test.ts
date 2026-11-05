import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createCollectionJob } from '../../src/content/collection-job.ts';
import { createErasureJob } from '../../src/content/erasure-job.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const storage = new R2Storage({
  endpoint: 'https://media-import-test.r2.cloudflarestorage.com',
  bucket: 'media-import-test',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  fetch: (request) => fetch(request),
  maxObjectBytes: 20 * 1024 * 1024,
});

// Import completion must use these production dependencies. Keep their missing
// integration visible rather than substituting a processor, state machine or worker.
test('trusted media import has a content module in the single native worker', () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module.name === 'content')).toHaveLength(1);
});

test('trusted media import can use the shared native image publication pipeline', () => {
  expect(typeof createImageJob(pool, storage).process).toBe('function');
});

test('trusted media import can coordinate with the native collection fence', () => {
  expect(typeof createCollectionJob(pool, storage).collectPartition).toBe('function');
});

test('trusted media import can use durable native governance prefix purge', () => {
  expect(typeof createErasureJob(pool, storage).purgeObject).toBe('function');
});
