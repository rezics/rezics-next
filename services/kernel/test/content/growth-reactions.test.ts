import { createHash } from 'node:crypto';
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
  const bodyHash = createHash('sha256').update('body').digest();
  const population: Population = {
    name: `reactions-${crypto.randomUUID()}`,
    hotPartition: partitionOf(f.home),
    hotShare: 0.75,
    rows: ({ route, ordinal }) => {
      const actorId = newId(route),
        thread = newId(f.targetRoute),
        post = newId(f.targetRoute),
        revision = newId(f.targetRoute),
        board = newId(0x5231);
      return {
        'access.account': [{ route, account_id: actorId, kind: 'actor', state: 'active', transaction_id: actorId }],
        'content.board': [
          {
            route: 0x5231,
            board_id: board,
            subject_id: actorId,
            title: 'Other board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: actorId,
          },
        ],
        'content.thread': [
          {
            route: f.targetRoute,
            thread_id: thread,
            author_account_id: actorId,
            board_id: board,
            first_post_id: post,
            title: 'Other target',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: actorId,
          },
        ],
        'content.post': [
          {
            route: f.targetRoute,
            thread_id: thread,
            post_id: post,
            author_account_id: actorId,
            head_revision_id: revision,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: actorId,
          },
        ],
        'content.revision': [
          {
            route: f.targetRoute,
            thread_id: thread,
            post_id: post,
            revision_id: revision,
            body: Buffer.from('body'),
            body_sha256: new Uint8Array(bodyHash),
            search_text: 'body',
            licence: 'CC0-1.0',
            subject_ids: [],
            board_id: board,
            availability: 'available',
            recorded_transaction_id: actorId,
          },
        ],
        'access.membership_inverse': [
          {
            route,
            account_id: actorId,
            kind: 'realm',
            group_id: board,
            reservation_id: actorId,
            transaction_id: actorId,
          },
        ],
        'access.resource_grant': [
          {
            route: f.targetRoute,
            resource_id: thread,
            subject_id: actorId,
            action: 'reaction:set',
            valid: '(,)',
            transaction_id: actorId,
          },
        ],
        'access.resource_role_grant': [
          {
            route: f.targetRoute,
            resource_id: thread,
            subject_id: actorId,
            grant_role: 'content.thread.owner',
            valid: '(,)',
            transaction_id: actorId,
          },
        ],
        'access.resource_denial': [
          {
            route: f.targetRoute,
            resource_id: thread,
            subject_id: actorId,
            action: 'thread:read',
            reason: 'resource',
            valid: '(,)',
            transaction_id: actorId,
          },
        ],
        'core.receipt': [
          {
            partition_no: partitionOf(route),
            principal_kind: 'account',
            principal_id: actorId,
            command_kind: 'content.reaction.set',
            idempotency_key: actorId,
            request_digest: new Uint8Array(32),
            epoch: 1,
            position: 1,
            transaction_id: actorId,
            response: {},
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
  // Keep unrelated authority and container tables large enough for native index
  // plans at the first reaction scale as well as at the last one.
  await seed(
    f.db,
    {
      ...population,
      name: `${population.name}-background`,
      rows(placement) {
        const { 'content.reaction': _slots, ...rows } = population.rows!(placement);
        return rows;
      },
    },
    { from: 0, to: 4096 },
  );
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
  for (const sample of report.samples) {
    const cost = sample.cost as typeof sample.cost & { relations: NonNullable<typeof sample.cost.relations> };
    expect(cost.rows).toBe(report.samples[0]!.cost.rows);
    expect(cost.statements).toBe(report.samples[0]!.cost.statements);
    expect(cost.relations['content.reaction']).toBeDefined();
    for (const relation of Object.values(cost.relations)) expect(relation.sequentialScans).toBe(0);
  }
}, 120_000);
