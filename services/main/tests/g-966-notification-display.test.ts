import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { ResourceSummary } from '../src/modules/media/summary.ts';
import {
  notificationNewWorkDisplay,
  NOTIFICATION_NEW_WORK_DISPLAY_COST,
} from '../src/modules/notification/display.ts';
import {
  NotificationStore,
  SETTINGS_NOTIFICATION_TOPICS,
  NOTIFICATION_SETTINGS_COST,
} from '../src/modules/notification/store.ts';

const work = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const concept = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const input = {
  principalId: '33333333-3333-4333-8333-333333333333',
  owner: 'access',
  ref: '44444444-4444-4444-8444-444444444444',
  work,
};
const summary = (reference: string, type: 'work' | 'concept', value: string): ResourceSummary => ({
  reference,
  status: 'available',
  type,
  disclosure: 'public',
  base: type === 'work' ? 'work' : null,
  work: type === 'work' ? work : null,
  address: {
    prefix: type === 'work' ? '/w/' : '/concepts/',
    key: 'rainy-bookshop',
    suffixSource: value,
  },
  name: { value, language: 'zh-Hans', direction: 'ltr', basis: 'fallback' },
  avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: reference, resourceType: type },
});
const current = [summary(work, 'work', '雨夜书店'), summary(concept, 'concept', 'Fantasy')];
function views(
  view: { name: string | null; concept: string | null; revision: string } | null,
  after = view,
) {
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, args: unknown[]) => {
      calls.push(args);
      return {
        rows: (calls.length === 1 ? view : after) ? [calls.length === 1 ? view : after] : [],
      };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('G-966 a followed topic resolves current Work and Concept names with the canonical address', async () => {
  const { pool, calls } = views({ name: null, concept, revision: '1' });
  const requests: string[][] = [];
  expect(
    await notificationNewWorkDisplay(pool, input, async (resources) => {
      requests.push(resources);
      return current;
    }),
  ).toEqual({
    title: '雨夜书店',
    language: 'zh-Hans',
    topicName: 'Fantasy',
    href: '/w/rainy-bookshop',
    linkTarget: work,
  });
  expect(requests).toEqual([[work, concept]]);
  expect(calls).toEqual([
    [input.ref, input.principalId],
    [input.ref, input.principalId],
  ]);
  expect(calls.length).toBe(NOTIFICATION_NEW_WORK_DISPLAY_COST.accessStatements);
  expect(requests[0]!.length).toBe(NOTIFICATION_NEW_WORK_DISPLAY_COST.summaryItems);
});

test('G-966 a named saved view is private to its principal and keeps its current label', async () => {
  const { pool } = views({ name: 'Two conditions', concept: null, revision: '2' });
  expect(
    await notificationNewWorkDisplay(pool, input, async (resources) => {
      expect(resources).toEqual([work]);
      return [current[0]!];
    }),
  ).toMatchObject({ topicName: 'Two conditions', title: '雨夜书店' });
  const missing = views(null);
  let hydrated = false;
  expect(
    await notificationNewWorkDisplay(missing.pool, input, async () => {
      hydrated = true;
      return current;
    }),
  ).toBeNull();
  expect(hydrated).toBe(false);
});

for (const hidden of [work, concept])
  test(`G-966 a hidden or deleted ${hidden === work ? 'Work' : 'topic'} reveals no display`, async () => {
    const { pool } = views({ name: 'Custom topic label', concept, revision: '1' });
    expect(
      await notificationNewWorkDisplay(pool, input, async () =>
        current.map((item) =>
          item.reference === hidden ? { reference: hidden, status: 'unavailable' as const } : item,
        ),
      ),
    ).toBeNull();
  });

test('G-966 a private Work and a view renamed or removed during hydration fail closed', async () => {
  const before = { name: 'My view', concept: null, revision: '1' };
  const { pool } = views(before);
  expect(
    await notificationNewWorkDisplay(pool, input, async () => [
      { ...current[0]!, disclosure: 'restricted' } as ResourceSummary,
    ]),
  ).toBeNull();
  for (const after of [null, { ...before, name: 'Renamed', revision: '2' }]) {
    expect(
      await notificationNewWorkDisplay(views(before, after).pool, input, async () => current),
    ).toBeNull();
  }
});

test('G-966 producer topics expose inbox, push and opt-in email digest preferences within the declared bound', async () => {
  const queries: string[] = [];
  const client = {
    release() {},
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('recovery_fence')) return { rows: [{ open: true }] };
      if (sql.includes('FROM access.principal'))
        return { rows: [{ id: input.principalId, active: true }] };
      if (sql.includes('FROM access.notification_preference'))
        return {
          rows: [
            {
              purpose: 'subscription',
              topic: 'new-work',
              channel: 'push',
              state: 'disabled',
              revision: '7',
            },
            {
              purpose: 'subscription',
              topic: 'new-work',
              channel: 'email',
              state: 'enabled',
              revision: '8',
            },
          ],
        };
      return { rows: [] };
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const items = await new NotificationStore(pool).readSettingsPreferences({
    issuer: 'test',
    subject: 'test',
  });
  expect(items.filter((item) => item.topic === 'new-work')).toEqual([
    {
      purpose: 'subscription',
      topic: 'new-work',
      channel: 'inbox',
      state: 'enabled',
      revision: null,
    },
    {
      purpose: 'subscription',
      topic: 'new-work',
      channel: 'push',
      state: 'disabled',
      revision: '7',
    },
    {
      purpose: 'subscription',
      topic: 'new-work',
      channel: 'email',
      state: 'enabled',
      revision: '8',
    },
  ]);
  expect(items.length).toBe(SETTINGS_NOTIFICATION_TOPICS.length * 3);
  expect(items.length).toBe(NOTIFICATION_SETTINGS_COST.responseItems);
  expect(items.find((item) => item.topic === 'reply' && item.channel === 'email')?.state).toBe(
    'disabled',
  );
  expect(queries.find((sql) => sql.includes('FROM access.notification_preference'))).toContain(
    "channel IN ('inbox', 'push', 'email')",
  );
});

test('G-966 other new-Work producers retain a canonical Work link without inventing a matched topic', async () => {
  const pool = {
    query: async () => {
      throw new Error('Graph notices must not read private views');
    },
  } as unknown as Pool;
  expect(
    await notificationNewWorkDisplay(pool, { ...input, owner: 'graph', ref: work }, async () => [
      current[0]!,
    ]),
  ).toMatchObject({ topicName: null, href: '/w/rainy-bookshop', title: '雨夜书店' });
});
