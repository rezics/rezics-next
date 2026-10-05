import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { MediaAccessBatchReader } from '../src/modules/media/access-batch.ts';

const resource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
// Any pool use would mean the check ran after a database round trip.
const pool = new Proxy({}, { get() { throw new Error('pool must not be reached'); } }) as Pool;

test('public disclosure on a registry without a baseline graph throws instead of answering "not public"', async () => {
  const registry = new AccessAdmissionRegistry(pool);
  await expect(registry.canReadSemanticResource(null, null, resource)).rejects.toThrow('configureBaseline');
  await expect(new MediaAccessBatchReader(pool).canReadSemantics(null, null, [resource]))
    .rejects.toThrow('configureBaseline');
});

test('a malformed resource is still plainly not readable without a baseline graph', async () => {
  expect(await new AccessAdmissionRegistry(pool).canReadSemanticResource(null, null, 'not-a-resource')).toBe(false);
});

test('the production composition configures the baseline graph on the registry it serves', () => {
  const root = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  expect(root).toMatch(/const access = new AccessAdmissionRegistry\(/);
  expect(root).toMatch(/\baccess\.configureBaseline\(fuseki\);/);
});
