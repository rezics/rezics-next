import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { AccessClient } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import type { HostedAppendDescriptor } from '../../src/content/hosted-chapters-model.ts';
import { hostedReadPlacementPage } from '../../src/content/hosted-chapters-store.ts';
import { hostedCursorBinding, readHostedCursor, writeHostedCursor } from '../../src/content/hosted-chapters-cursor.ts';
import appendPrevious from '../../src/content/hosted-append-read-previous.sql';

// A sparse boundary response exercises arithmetic and SQL parameter transport;
// the native fixture separately owns actual immutable prefix membership/order.
test('bigint offsets preserve exact addresses and reverse frontiers through the wire and token', async () => {
  const id = newId(7),
    revisionId = newId(7),
    occurrenceId = newId(7);
  const descriptor: HostedAppendDescriptor = {
    revisionId,
    baseRevisionId: newId(7),
    basePlacementCount: 512n,
    baseRootCount: 511n,
    highWater: BigInt(Number.MAX_SAFE_INTEGER) - 514n,
  };
  const row = {
    append_offset: descriptor.highWater.toString(),
    occurrence_id: occurrenceId,
    title: 'Exact boundary',
    thread_id: newId(9),
    post_id: newId(9),
    target_revision_id: newId(9),
    sha256: 'a'.repeat(64),
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  const client: AccessClient = {
    query: (async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: sql === appendPrevious.sql ? [row] : [] };
    }) as AccessClient['query'],
  };
  const query = { mode: 'previous' as const, parentId: null, after: Number.MAX_SAFE_INTEGER - 1, limit: 3 };
  const [exact] = await hostedReadPlacementPage(client, id, revisionId, query, descriptor);
  expect(exact).toMatchObject({
    occurrenceId,
    ordinal: Number.MAX_SAFE_INTEGER - 2,
    position: Number.MAX_SAFE_INTEGER - 3,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.sql).toContain('p.ordinal<$4::bigint');
  expect(calls[1]!.values[appendPrevious.params.indexOf('after_offset')]).toBe((BigInt(query.after) - 512n).toString());
  expect(calls[1]!.values[appendPrevious.params.indexOf('limit')]).toBe(3);
  const deps = {
    tokens: { current: 1, keys: new Map([[1, randomBytes(32)]]) },
    clock: () => new Date(1_000_000),
  };
  const binding = hostedCursorBinding(
    id,
    { revisionId },
    { actor: { kind: 'anonymous' }, deadline: 2_000_000 },
    { ...query, occurrenceId, limit: 2 },
  );
  const state = { revisionId, after: exact!.ordinal, origin: query.after, issuedAt: 1_000_000, epoch: 1 };
  expect(readHostedCursor(deps, binding, id, writeHostedCursor(deps, binding, state))).toEqual(state);
});
