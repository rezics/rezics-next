import { expect, test } from 'bun:test';
import type { AccessClient } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import {
  HOSTED_BASE_PREORDER_MAX,
  HOSTED_BASE_ROOT_MAX,
  HOSTED_APPEND_DESCRIPTOR_SELECT,
  HOSTED_EXACT_INTEGER_MAX,
  hostedAppendDescriptor,
  nextHostedAppend,
  sealHostedAppendBase,
} from '../../src/content/hosted-chapters-append.ts';
import type { HostedAppendDescriptor } from '../../src/content/hosted-chapters-model.ts';

const catalogueId = newId(7),
  revisionId = newId(7);

test('empty and depth-16 legacy bases seal with two index extrema and no placement copy', async () => {
  for (const [ordinal, position, placements, roots] of [
    [undefined, undefined, 0n, 0n],
    [511, 496, 512n, 497n],
  ] as const) {
    const calls: string[] = [];
    const client: AccessClient = {
      query: (async (sql: string, values: unknown[]) => {
        calls.push(sql);
        expect(values.slice(0, 3)).toEqual([7, catalogueId, revisionId]);
        if (sql === HOSTED_APPEND_DESCRIPTOR_SELECT) return { rows: [] };
        if (sql === HOSTED_BASE_PREORDER_MAX) return { rows: ordinal === undefined ? [] : [{ ordinal }] };
        if (sql === HOSTED_BASE_ROOT_MAX) return { rows: position === undefined ? [] : [{ position }] };
        expect(sql).toContain('INSERT INTO content.hosted_append_descriptor');
        expect(values.slice(3)).toEqual([revisionId, placements.toString(), roots.toString(), '-1']);
        return { rows: [] };
      }) as AccessClient['query'],
    };
    expect(await sealHostedAppendBase(client, catalogueId, revisionId)).toEqual({
      revisionId,
      baseRevisionId: revisionId,
      basePlacementCount: placements,
      baseRootCount: roots,
      highWater: -1n,
    });
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain('ORDER BY ordinal DESC LIMIT 1');
    expect(calls[2]).toContain('parent_id IS NULL\n  ORDER BY position DESC LIMIT 1');
  }
});

test('prefix coordinates cross 512 and reject exact-count overflow before arithmetic can round', () => {
  const base: HostedAppendDescriptor = {
    revisionId,
    baseRevisionId: revisionId,
    basePlacementCount: 512n,
    baseRootCount: 497n,
    highWater: -1n,
  };
  expect(nextHostedAppend(base)).toEqual({ offset: 0n, ordinal: 512n, position: 497n });
  const atCapacity = { ...base, highWater: HOSTED_EXACT_INTEGER_MAX - 514n };
  expect(nextHostedAppend(atCapacity)).toEqual({
    offset: HOSTED_EXACT_INTEGER_MAX - 513n,
    ordinal: HOSTED_EXACT_INTEGER_MAX - 1n,
    position: HOSTED_EXACT_INTEGER_MAX - 16n,
  });
  expect(() => nextHostedAppend({ ...atCapacity, highWater: atCapacity.highWater + 1n })).toThrow(
    'Hosted structure exceeds exact integer capacity',
  );
  expect(base.highWater).toBe(-1n);
});

test('an existing prefix decodes exact counters and follows its sealed base without another probe', async () => {
  const baseRevisionId = newId(7);
  let queries = 0;
  const client: AccessClient = {
    query: (async (sql: string, values: unknown[]) => {
      queries++;
      expect(sql).toBe(HOSTED_APPEND_DESCRIPTOR_SELECT);
      expect(values).toEqual([7, catalogueId, revisionId]);
      return {
        rows: [
          {
            revision_id: revisionId,
            base_revision_id: baseRevisionId,
            base_placement_count: '512',
            base_root_count: '497',
            high_water: '9007199254740478',
          },
        ],
      };
    }) as AccessClient['query'],
  };
  expect(await hostedAppendDescriptor(client, catalogueId, revisionId)).toEqual({
    revisionId,
    baseRevisionId,
    basePlacementCount: 512n,
    baseRootCount: 497n,
    highWater: 9007199254740478n,
  });
  expect(queries).toBe(1);
});
