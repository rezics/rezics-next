import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { reactionFixture, request } from './reactions.test.ts';
import { observeSql } from './support/sql-observer.ts';

let f: Awaited<ReturnType<typeof reactionFixture>>;
let commands: typeof import('../../src/content/reactions.ts');
beforeAll(async () => {
  f = await reactionFixture();
  commands = await import('../../src/content/reactions.ts');
}, 120_000);
afterAll(async () => {
  await f?.close();
});
test('reaction writes remain one point mutation with constant rows and statements and zero sequential scans', async () => {
  const target = await f.target();
  const actor = await f.verified();
  const population: Population = {
    name: `reactions-${crypto.randomUUID()}`,
    hotPartition: partitionOf(f.home),
    hotShare: 0.75,
    rows: ({ route, ordinal }) => {
      const actorId = newId(route),
        thread = newId(f.targetRoute);
      return {
        'access.account': [{ route, account_id: actorId, kind: 'actor', state: 'active', transaction_id: actorId }],
        'content.thread': [
          {
            route: f.targetRoute,
            thread_id: thread,
            author_account_id: actorId,
            board_id: target.board,
            title: 'Other target',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: actorId,
          },
        ],
        'content.reaction': [
          {
            route,
            actor_account_id: actorId,
            target_kind: 'thread',
            target_route: f.targetRoute,
            target_id: ordinal % 2 ? target.thread : thread,
            kind: 'like',
            updated_at: '2026-10-25T00:00:00Z',
          },
        ],
      };
    },
  };
  const report = await checkGrowth(f.db, {
    name: 'Reaction slot',
    scales: [256, 2048, 16384],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(db, scale, previous) {
      await seed(db, population, { from: previous, to: scale });
    },
    async operation(_db, _scale, repetition) {
      const trace = observeSql(f.db.pool);
      try {
        const result = await commands.setReaction(
          { pool: f.db.pool, access: f.access },
          actor,
          { targetKind: 'thread', targetId: target.thread, kind: repetition % 2 ? 'upvote' : 'downvote' },
          request(),
        );
        expect(result?.partition).toBe(partitionOf(f.home));
        expect(trace.records.filter((r) => /INSERT INTO content\.reaction/i.test(r.statement))).toHaveLength(1);
        expect(
          trace.records.filter((r) => r.statement.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"')),
        ).toHaveLength(1);
      } finally {
        await trace.close();
      }
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([256, 2048, 16384]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(report.samples[0]!.cost.rows);
    expect(cost.statements).toBe(report.samples[0]!.cost.statements);
    expect(cost.relations['content.reaction']).toBeDefined();
    for (const relation of Object.values(cost.relations)) expect(relation.sequentialScans).toBe(0);
  }
}, 120_000);
