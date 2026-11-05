import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createSubject } from '../../src/semantic/subject.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createReactionCountEffect } from '../../src/content/reaction-projection.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { reactionFixture, request } from './reactions.test.ts';
import { observeSql } from './support/sql-observer.ts';

let f: Awaited<ReturnType<typeof reactionFixture>>;
let commands: typeof import('../../src/content/reactions.ts');
beforeAll(async () => {
  f = await reactionFixture();
  commands = await import('../../src/content/reactions.ts');
  await bootstrapRelease(f.db.pool, bundledRelease);
}, 120_000);
afterAll(async () => {
  await f?.close();
});

async function subject(label: string): Promise<string> {
  const id = newId(f.targetRoute);
  await createSubject(f.db.pool, {
    actor: await f.verified(f.managerId),
    target: { route: f.targetRoute, id },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  await f.grant(id, ['reaction:set']);
  return id;
}
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
    scales: [64, 512, 4096],
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
  expect(report.samples.map((s) => s.scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) {
    const cost = sample.cost as typeof sample.cost & { relations: NonNullable<typeof sample.cost.relations> };
    expect(cost.rows).toBe(report.samples[0]!.cost.rows);
    expect(cost.statements).toBe(report.samples[0]!.cost.statements);
    expect(cost.relations['content.reaction']).toBeDefined();
    for (const relation of Object.values(cost.relations)) expect(relation.sequentialScans).toBe(0);
  }
}, 120_000);

test('Subject reaction slot', async () => {
  const targetId = await subject('Subject reaction slot growth target');
  const warmupTargets = new Map<number, string>();
  for (const scale of [64, 512, 4096]) warmupTargets.set(scale, await subject(`Subject reaction slot warmup ${scale}`));
  const actor = await f.verified();
  let measured = 0;
  const population: Population = {
    name: `subject-reaction-slots-${crypto.randomUUID()}`,
    hotPartition: partitionOf(f.home),
    hotShare: 1,
    rows: ({ route }) => {
      const actorId = newId(route);
      return {
        'access.account': [{ route, account_id: actorId, kind: 'actor', state: 'active', transaction_id: actorId }],
        'content.reaction': [
          {
            route,
            actor_account_id: actorId,
            target_kind: 'subject',
            target_route: f.targetRoute,
            target_id: targetId,
            kind: 'like',
            updated_at: '2026-10-27T00:00:00Z',
          },
        ],
      };
    },
  };
  const report = await checkGrowth(f.db, {
    name: 'Subject reaction slot',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
    },
    async warmup(_database, scale, repetition) {
      await commands.setReaction(
        { pool: f.db.pool, access: f.access },
        actor,
        { targetKind: 'subject', targetId: warmupTargets.get(scale)!, kind: repetition % 2 ? 'love' : 'like' },
        request(),
      );
    },
    async operation(_database, _scale, _repetition) {
      await commands.setReaction(
        { pool: f.db.pool, access: f.access },
        actor,
        { targetKind: 'subject', targetId, kind: measured++ % 2 ? 'love' : 'like' },
        request(),
      );
    },
    repetitions: 1,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) {
    const cost = sample.cost as typeof sample.cost & { relations: NonNullable<typeof sample.cost.relations> };
    expect(cost.relations['content.reaction']).toBeDefined();
    expect(cost.relations['content.reaction']?.sequentialScans).toBe(0);
  }
  expect(report.samples[0]!.cost.rows).toBe(report.samples[2]!.cost.rows);
  expect(report.samples[0]!.cost.statements).toBe(report.samples[2]!.cost.statements);
}, 120_000);

test('Subject reaction relay', async () => {
  const scales = [64, 512, 4096] as const;
  const targets = new Map<number, { measured: string; warmup: string }>();
  for (const scale of scales)
    targets.set(scale, {
      measured: await subject(`Subject reaction relay growth target ${scale}`),
      warmup: await subject(`Subject reaction relay warmup ${scale}`),
    });
  const relayActorRoute = 0x3312;
  const sourcePartition = partitionOf(relayActorRoute);
  const subjectIds = [...targets.values()].flatMap(({ measured, warmup }) => [measured, warmup]);
  // Both paths update a live counter exactly once, with identical initial versions.
  for (const targetId of subjectIds) {
    await f.db.admin.query(
      `INSERT INTO content.reaction_count
         (route,target_id,source_partition,kind,count,source_epoch,source_position)
       VALUES ($1,$2,$3,'like',1,1,1)`,
      [f.targetRoute, targetId, sourcePartition],
    );
    await f.db.admin.query(
      `INSERT INTO content.reaction_total (route,target_id,kind,count,source_epoch,source_position)
       VALUES ($1,$2,'like',1,1,1)`,
      [f.targetRoute, targetId],
    );
  }
  const population: Population = {
    name: `subject-reaction-reactors-${crypto.randomUUID()}`,
    hotPartition: partitionOf(f.targetRoute),
    hotShare: 1,
    rows: ({ route }) => ({
      'content.subject_reactor': subjectIds.map((subjectId) => ({
        route: f.targetRoute,
        subject_id: subjectId,
        actor_account_id: newId(route),
        kind: 'like',
      })),
    }),
  };
  const effect = createReactionCountEffect(f.db.pool);
  function event(subjectId: string, position: number, actorId = newId(relayActorRoute)): CloudEvent {
    return {
      specversion: '1.0',
      id: crypto.randomUUID(),
      source: `urn:rezics:log:${sourcePartition}.1`,
      type: 'com.rezics.content.reaction.changed.v1',
      subject: subjectId,
      time: '2026-10-27T00:00:00.000Z',
      datacontenttype: 'application/json',
      sequence: position.toString().padStart(19, '0'),
      data: { actorId, targetKind: 'subject', targetId: subjectId, previousKind: null, kind: 'like' },
    };
  }
  let position = 1;
  const report = await checkGrowth(f.db, {
    name: 'Subject reaction relay',
    rule: 'series',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
    },
    async warmup(_database, scale) {
      await effect.run(event(targets.get(scale)!.warmup, ++position));
    },
    async operation(_database, scale) {
      await effect.run(event(targets.get(scale)!.measured, ++position));
    },
    repetitions: 1,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) {
    const cost = sample.cost as typeof sample.cost & { relations: NonNullable<typeof sample.cost.relations> };
    expect(cost.relations['content.subject_reactor']).toBeDefined();
    expect(cost.relations['content.subject_reactor']?.sequentialScans).toBe(0);
  }
  expect(report.samples[0]!.cost.rows).toBe(report.samples[2]!.cost.rows);
  expect(report.samples[0]!.cost.statements).toBe(report.samples[2]!.cost.statements);
  for (const targetId of subjectIds) {
    const indexed = await f.db.admin.query<{ reactors: number }>(
      'SELECT count(*)::int AS reactors FROM content.subject_reactor WHERE route=$1 AND subject_id=$2',
      [f.targetRoute, targetId],
    );
    expect(indexed.rows[0]!.reactors).toBe(4096 + 1);
  }
}, 120_000);
