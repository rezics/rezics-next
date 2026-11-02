import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { pageBulkOutcomes } from '../../src/library/bulk-outcome-page.ts';
import { bulkOutcomePageSchema } from '../../src/library/bulk-schemas.ts';
import type { TargetEvidence, ImmutableTarget } from '../../src/library/bulk-contract.ts';
import type { CollectionBulkOperation } from '../../src/library/collection-bulk-store.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

test('only exact stored applied removal evidence enters the typed page, with original native values', async () => {
  const route = 0x6a10, accountId = newId(route), operationId = newId(route), subjectId = newId(route);
  const sourceDigest = 'a'.repeat(64), transactionId = randomUUID(), restoreUntil = '2026-11-30 00:00:00+00';
  const receipt = { partition: partitionOf(route), principalKind: 'account' as const, principalId: accountId,
    commandKind: 'library.collectionBulk.target', key: `${operationId}:0`, digest: 'b'.repeat(64) };
  const target: ImmutableTarget = { kind: 'subject', operationId, ordinal: '0', subjectId, requestedSubjectId: null,
    expected: { kind: 'present', incarnation: newId(route), admissionSequence: '1', revision: 1 } };
  const evidence: TargetEvidence = { operationId, ordinal: '0', sourceDigest, receipt, transactionId,
    outcome: 'applied', reason: null, resultingMemberId: null,
    deletion: { deletionId: transactionId, revision: 2, restoreUntil } };
  const operation: Pick<CollectionBulkOperation, 'request' | 'sourceDigest'> = {
    sourceDigest, request: { action: 'remove_from_library', selection: { kind: 'explicit' } },
  };
  const row = { ordinal: '0', subjectId, memberId: null, collectionId: null, state: 'applied', reason: null,
    resultingMemberId: null, target, receipt, evidence, sourceDigest };
  const page = (patch = {}, source = operation) => {
    const client = { query: async () => ({ rows: [{ ...row, ...patch }] }) } as unknown as Pick<PoolClient, 'query'>;
    return pageBulkOutcomes(client, { route, accountId, operationId, after: null, limit: 1, state: null, operation: source });
  };
  const first = await page();
  expect(first.outcomes[0]?.deletion).toEqual(evidence.deletion);
  expect(Value.Check(bulkOutcomePageSchema, { outcomes: first.outcomes, next: null })).toBe(true);
  expect(Object.keys(first.outcomes[0]!).sort()).toEqual([
    'ordinal', 'subjectId', 'memberId', 'state', 'reason', 'resultingMemberId', 'deletion', 'memberDeletion',
  ].sort());
  for (const patch of [
    { evidence: null }, { target: { ...target, subjectId: newId(route) } },
    { evidence: { ...evidence, ordinal: '1' } }, { evidence: { ...evidence, sourceDigest: 'c'.repeat(64) } },
    { evidence: { ...evidence, receipt: { ...receipt, key: 'another' } } },
    { evidence: { ...evidence, deletion: { ...evidence.deletion, deletionId: randomUUID() } } },
    ...['pending', 'no_effect', 'conflict', 'denied', 'cancelled'].map((state) => ({ state })),
  ]) expect((await page(patch)).outcomes[0]).toMatchObject({ deletion: null, memberDeletion: null });
  expect((await page({}, { ...operation, request: { action: 'set_status', state: 'planned', selection: { kind: 'explicit' } } }))
    .outcomes[0]?.deletion).toBeNull();
  expect(await page()).toEqual(first);
});
