import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { readFences, type SourceFence, type SourceFenceTuple } from '../../src/content/source-fences.ts';
import { partitionOf } from '../../src/route/route.ts';

const signature: (
  client: Pick<PoolClient, 'query'>,
  tuples: readonly SourceFenceTuple[],
) => Promise<readonly SourceFence[]> = readFences;

function untouchedClient(): Pick<PoolClient, 'query'> {
  return new Proxy({} as Pick<PoolClient, 'query'>, {
    get() {
      throw new Error('Invalid or empty batches must not access the database');
    },
  });
}

function tuple(route: number): SourceFenceTuple {
  return { route, source: 'catalogue', external_id: 'record-1', field_group: 'summary' };
}

test('the exact low-level signature returns an empty batch without database access', async () => {
  expect(await signature(untouchedClient(), [])).toEqual([]);
});

test('fence reads reject more than one hundred exact tuple keys before database access', async () => {
  await expect(readFences(untouchedClient(), Array.from({ length: 101 }, () => tuple(0)))).rejects.toBeInstanceOf(
    RangeError,
  );
});

test('fence reads reject mixed tuple partitions before database access', async () => {
  const otherRoute = Array.from({ length: 65536 }, (_, route) => route).find(
    (route) => partitionOf(route) !== partitionOf(0),
  )!;
  await expect(readFences(untouchedClient(), [tuple(0), tuple(otherRoute)])).rejects.toBeInstanceOf(RangeError);
});
