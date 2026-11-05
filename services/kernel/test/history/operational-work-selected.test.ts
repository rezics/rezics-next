import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { readFileSync } from 'node:fs';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import {
  registerPositionedOperationalHistoryWork,
  reserveOperationalWorkTransfer,
  resolveCommittedOperationalWork,
  type OperationalMembersBinding,
} from '../../src/history/operational-work.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { WorkIntent } from '../../src/work/client.ts';
import { operationalFixture } from '../command/support/operational-fixture.ts';
// UNRUN: native original funding/association oracles are deferred to integration.
let native: Awaited<ReturnType<typeof operationalFixture>>;
beforeAll(async () => {
  native = await operationalFixture(3088);
});
afterAll(async () => {
  await native?.close();
});

test('Expired postcommit original transfer remains refused; selection never renews or borrows it', async () => {
  const ownerAccountId = native.actor.accountId,
    route = routeOf(ownerAccountId)!;
  const collectionId = newId(route),
    episodeId = newId(route);
  const canonicalBasis = canonicalize([1, ownerAccountId, collectionId, { status: 'owned' }, 'id', 'a'.repeat(64)])!;
  const binding: OperationalMembersBinding = {
    route,
    ownerAccountId,
    collectionId,
    retired: [],
    episodes: [
      {
        collectionId,
        episodeId,
        reservedIncarnation: `${collectionId}:1`,
        reservedGeneration: '1',
        canonicalBasis,
        basisDigest: createHash('sha256').update(canonicalBasis).digest('hex'),
      },
    ],
  };
  const intent: WorkIntent = {
    queue: 'workflows',
    workflowName: 'library.membersPreparation',
    workflowId: `library:members-preparation:${route}:${ownerAccountId}:${episodeId}`,
    input: { accounts: [ownerAccountId], route, episodes: [{ collectionId, episodeId }], cleanup: [] },
  };
  const result = await runOperationalTransaction(
    native.db.pool,
    {
      ...(await native.request()),
      partition: partitionOf(route),
      accounts: [ownerAccountId],
      kind: 'library.membersPreparation',
      operationalHistory: true,
    },
    async (tx) => ({
      locator: await registerPositionedOperationalHistoryWork(tx, binding, intent),
      transfer: reserveOperationalWorkTransfer(tx, 'resolve'),
    }),
  );
  const checkout = spyOn(native.db.pool, 'connect');
  const time = spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
  try {
    await expect(resolveCommittedOperationalWork(native.db.pool, result.locator, result.transfer)).rejects.toThrow(
      'operational-work-native-transfer-unavailable',
    );
    expect(checkout).not.toHaveBeenCalled();
  } finally {
    time.mockRestore();
    checkout.mockRestore();
  }
});
test('Immutable original and episode bindings survive uncertain commit reconciliation without rewritable result state', () => {
  const sql = readFileSync(
    new URL('../../db/migrations/20261102110241_operational_work_selection.sql', import.meta.url),
    'utf8',
  );
  expect(sql).toContain('PRIMARY KEY(partition_no,workflow_id,function_id)');
  expect(sql).toContain("(to_jsonb(OLD)-'result')=(to_jsonb(NEW)-'result')");
  expect(sql).toContain('OLD.result IS NULL AND NEW.result IS NOT NULL');
  expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
  expect(sql).toContain("parent.result->>'continuation' IS DISTINCT FROM NEW.workflow_id");
  expect(sql).toContain('selected operational association is permanent');
  expect(sql).toContain('ENABLE ALWAYS TRIGGER operational_work_selected_continuation_bound');
  expect(sql).toContain('-- migrate:up');
  expect(sql).toContain('-- migrate:down');
});
