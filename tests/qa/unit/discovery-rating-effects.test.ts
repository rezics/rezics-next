import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  discoveryEventEffect,
  discoveryEventWorks,
} from '../../../services/main/src/modules/discovery/effects.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import { standingRatingSlotIri } from '../../../services/main/src/modules/rating/observation.ts';
import type { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { WorkReadLimit } from '../../../services/main/src/modules/work/read-session.ts';

const native = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = native(1),
  mainVersion = native(2),
  context = native(3),
  target = native(4);
const base = { scope: 'global' as const, realm: null, context: null, owner: null };
const rated = { ...base, context };

test('Only an exact MainVersion target changes a standing Work aggregate', () => {
  const rating = { action: 'rating.observation.set', ratingContext: context, work, mainVersion };
  expect(discoveryEventEffect({ ...rating, target: mainVersion }, rated)).toBe('work');
  expect(discoveryEventWorks({ ...rating, target: mainVersion })).toEqual([work]);
  expect(discoveryEventEffect({ ...rating, target }, rated)).toBe('irrelevant');
  expect(discoveryEventEffect({ ...rating, target: mainVersion }, base)).toBe('irrelevant');
  expect(
    discoveryEventEffect({ ...rating, target: mainVersion, outcome: 'cancelled' }, rated),
  ).toBe('irrelevant');
  expect(discoveryEventEffect({ action: 'future.rating', target }, rated)).toBeUndefined();
  const owner = '00000000-0000-4000-8000-000000000005';
  const mine = { ...rated, scope: 'mine' as const, owner };
  expect(
    discoveryEventEffect({ ...rating, target: mainVersion, ratingSlot: 'foreign' }, mine),
  ).toBe('irrelevant');
  expect(
    discoveryEventEffect(
      {
        ...rating,
        target: mainVersion,
        ratingSlot: standingRatingSlotIri(owner, context, mainVersion),
      },
      mine,
    ),
  ).toBe('work');
});

test('Relay target-only receipts resolve exact MainVersion ownership in one bounded graph query', async () => {
  let receipt: Record<string, unknown> = {
    action: 'rating.observation.set',
    outcome: 'succeeded',
    ratingContext: context,
    target: mainVersion,
  };
  const pool = {
    query: async () => ({
      rows: [
        {
          sequence: '11',
          batch_id: 'batch',
          routing_epoch: 'route',
          event_count: 1,
          event_id: 'event',
          envelope: {
            specversion: '1.0',
            id: 'event',
            source: 'https://rezics.com/services/main',
            data: {
              batchId: 'batch',
              routingEpoch: 'route',
              ordinal: 0,
              sourcePosition: { dataEpoch: 'epoch', sequence: '11' },
              receipt,
            },
          },
        },
      ],
    }),
  } as unknown as Pick<Pool, 'query'>;
  const inputs = new DiscoveryRefreshInputs(pool, 'consumer');
  const position = { dataEpoch: 'epoch', sequence: '11' };
  let queries = 0;
  const session = {
    query: async (query: string, limit: number) => {
      queries++;
      expect(query).toContain('a rv:MainVersion');
      expect(query).toContain('rv:mainVersion ?target');
      expect(limit).toBe(1);
      return [{ target: { type: 'uri', value: mainVersion }, work: { type: 'uri', value: work } }];
    },
  } as Pick<WorkReadSession, 'query'>;
  expect(await inputs.read(position, '10', rated, session)).toEqual({ works: [work], created: [] });
  expect(queries).toBe(1);
  receipt = { ...receipt, work: target };
  expect(await inputs.read(position, '10', rated, session)).toBeNull();
  const oversized = {
    query: async () => {
      throw new WorkReadLimit('Ambiguous target ownership');
    },
  } as Pick<WorkReadSession, 'query'>;
  expect(await inputs.read(position, '10', rated, oversized)).toBeNull();
  receipt = { ...receipt, work: undefined };
  expect(await inputs.read(position, '10', rated)).toBeNull();
  expect(await inputs.read(position, '10', base, session)).toEqual({ works: [], created: [] });
  expect(queries).toBe(2);
  const irrelevantSession = { query: async () => [] } as Pick<WorkReadSession, 'query'>;
  receipt = { ...receipt, target };
  expect(await inputs.read(position, '10', rated, irrelevantSession)).toEqual({
    works: [],
    created: [],
  });
  receipt = { ...receipt, work, mainVersion };
  expect(await inputs.read(position, '10', rated, session)).toEqual({ works: [], created: [] });
  expect(queries).toBe(2);
  receipt = { ...receipt, action: 'future.rating' };
  expect(await inputs.read(position, '10', rated, session)).toBeNull();
});
