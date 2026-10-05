import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { MediaAccessBatchReader } from '../src/modules/media/access-batch.ts';
import { publicCatalogueWork } from '../src/modules/access/role-proof.ts';
import { publicSemantics, readSemanticDisclosure } from '../src/modules/access/semantic-disclosure.ts';

const resource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
// Any pool use would mean the check ran after a database round trip.
const pool = new Proxy({}, { get() { throw new Error('pool must not be reached'); } }) as Pool;

test('public disclosure on a registry without a baseline graph throws instead of answering "not public"', async () => {
  const registry = new AccessAdmissionRegistry(pool);
  await expect(registry.canReadSemanticResource(null, null, resource)).rejects.toThrow('configureBaseline');
  await expect(new MediaAccessBatchReader(pool).canReadSemantics(null, null, [resource]))
    .rejects.toThrow('configureBaseline');
  await expect(publicSemantics({ pool }, [resource])).rejects.toThrow('configureBaseline');
  await expect(readSemanticDisclosure({ pool }, null, null, [resource])).rejects.toThrow('configureBaseline');
  await expect(publicCatalogueWork(undefined, resource)).rejects.toThrow('configureBaseline');
  // An explicit grant cannot substitute for checking whether the reference is public.
  await expect(registry.canReadSemanticResource({ issuer: 'https://account.test', subject: 'writer' },
    resource, resource)).rejects.toThrow('configureBaseline');
});

test('a malformed resource is still plainly not readable without a baseline graph', async () => {
  expect(await new AccessAdmissionRegistry(pool).canReadSemanticResource(null, null, 'not-a-resource')).toBe(false);
  expect(await publicCatalogueWork(undefined, 'not-a-resource')).toBe(false);
});

test('empty disclosure batches need no graph or database access', async () => {
  expect(await publicSemantics({ pool }, [])).toEqual(new Set());
  expect(await readSemanticDisclosure({ pool }, null, null, []))
    .toEqual({ public: new Set(), granted: new Set() });
});

test('configured catalogue disclosure distinguishes public Works from hidden Works', async () => {
  for (const readable of [true, false]) {
    expect(await publicCatalogueWork({ query: async () => ({ boolean: readable }) }, resource)).toBe(readable);
  }
});

test('the production composition configures the baseline graph on the registry it serves', () => {
  const root = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  expect(root).toMatch(/const access = new AccessAdmissionRegistry\(/);
  expect(root).toMatch(/\baccess\.configureBaseline\(fuseki\);/);
  expect(root.indexOf('access.configureBaseline(fuseki);')).toBeLessThan(root.indexOf('createMainApp(fuseki,'));
});
