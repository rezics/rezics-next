import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { assertContentRecoveryCoverage, ContentRecoveryConflict, ownedReferences,
  type ContentRecoveryCoverage, type GraphContentReference }
  from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { foldRowCoverage, OwnerCoverageConflict, type OwnerCatalog, type OwnerTable }
  from '../../../services/main/src/modules/work/pg-recovery-frontier.ts';

const table = (name: string, key = ['id']): OwnerTable => {
  const [schema, relation] = name.split('.') as [string, string];
  return { name, schema, table: relation, key, keyTypes: key.map(() => 'uuid'), columns: [] };
};
const catalog = (tables: OwnerTable[], excluded: Record<string, string> = {}): OwnerCatalog =>
  ({ tables, excluded, digest: 'a'.repeat(64) });
const reference = (object: string, predicate = 'https://rezics.com/vocab/cites'): GraphContentReference =>
  ({ graph: 'urn:rezics:graph:current', subject: 'https://rezics.com/id/subject', predicate, object,
    byteDigest: null, preparationId: null, ownerEpoch: null, ownerSequence: null });
const id = '0190a3a4-8e3b-7c1d-9f2e-3a4b5c6d7e8f';

test('OPS03: a new owner schema table registers its owner-row IRI prefix without code changes', () => {
  const owners = catalog([table('content.revision'), table('claim_ledger.evidence_set_revision'),
    table('content.receipt_action', ['action']), table('pkg.go_sumdb_head', ['server'])]);
  const owned = ownedReferences(owners, [
    reference(`urn:rezics:claim_ledger:evidence-set-revision:${id}`),
    reference(`urn:rezics:content:match-unit:${'b'.repeat(64)}`),
    reference('urn:rezics:receipt:source-projection:abc'),
    reference(`urn:rezics:content:revision:${id}`, 'https://rezics.com/vocab/contentRevision'),
  ]);
  // Graph-local IRIs in an owner namespace name no table and bind nothing.
  expect(owned.references.map(item => item.object)).toEqual([
    `urn:rezics:claim_ledger:evidence-set-revision:${id}`, `urn:rezics:content:revision:${id}`]);
  expect([...owned.keys.entries()].map(([name, keys]) => [name, [...keys]]))
    .toEqual([['claim_ledger.evidence_set_revision', [id]]]);
  expect(owned.pinned.map(item => item.object)).toEqual([`urn:rezics:content:revision:${id}`]);
});

test('OPS03: owner references fail closed when excluded, composite or malformed', () => {
  const owners = catalog([table('content.revision'), table('verification.head', ['kind', 'id'])],
    { 'verification.cache': 'rebuildable cache' });
  expect(() => ownedReferences(owners, [reference('urn:rezics:verification:cache:1')]))
    .toThrow('graph references excluded owner state');
  expect(() => ownedReferences(owners, [reference('urn:rezics:verification:head:1')]))
    .toThrow('graph references a composite-key owner row');
  expect(() => ownedReferences(owners, [reference('urn:rezics:content:revision:not-a-uuid',
    'https://rezics.com/vocab/contentRevision')])).toThrow(ContentRecoveryConflict);
  // The graph enumeration never yields a non-identifier schema segment; a caller cannot either.
  expect(() => ownedReferences(owners, [reference(`urn:rezics:claim-ledger:evidence:${id}`)]))
    .toThrow('graph Content reference is malformed');
  expect(() => ownedReferences(owners, [{ ...reference(`urn:rezics:content:revision:${id}`),
    byteDigest: 'c'.repeat(64) }])).toThrow('graph Content reference is malformed');
  expect(() => ownedReferences(catalog([]), [reference(`urn:rezics:content:revision:${id}`,
    'https://rezics.com/vocab/contentRevision')])).toThrow('Content revision table is not covered');
});

test('OPS03: owner references bind in one order regardless of enumeration order', () => {
  const owners = catalog([table('content.revision'), table('verification.origin')]);
  const items = [reference(`urn:rezics:verification:origin:${id}`),
    { ...reference(`urn:rezics:content:revision:${id}`, 'https://rezics.com/vocab/contentRevision'),
      graph: 'urn:rezics:graph:receipts' }];
  expect(ownedReferences(owners, items).references)
    .toEqual(ownedReferences(owners, [...items].reverse()).references);
});

test('OPS03: folded owner coverage binds the table set and fails closed on a missing table', () => {
  const owners = catalog([table('access.principal'), table('access.probe')]);
  const rows = { 'access.principal': { count: '2', digest: 'd'.repeat(64) },
    'access.probe': { count: '0', digest: 'e'.repeat(64) } };
  const folded = foldRowCoverage('access-state-v5', owners, rows);
  expect(folded.count).toBe('2');
  expect(foldRowCoverage('access-state-v5', { ...owners, digest: 'f'.repeat(64) }, rows).digest)
    .not.toBe(folded.digest);
  expect(() => foldRowCoverage('access-state-v5', owners, { 'access.principal': rows['access.principal'] }))
    .toThrow(OwnerCoverageConflict);
});

test('OPS03: retained version-4 Content coverage fails with a version error before any owner read', async () => {
  const untouched = new Proxy({}, { get: () => { throw new Error('owner was read'); } });
  await expect(assertContentRecoveryCoverage(untouched as Pool, untouched as FusekiClient,
    { version: 4 } as unknown as ContentRecoveryCoverage))
    .rejects.toThrow('Content recovery coverage version 4 is not version 5; capture a fresh fenced cut');
});
