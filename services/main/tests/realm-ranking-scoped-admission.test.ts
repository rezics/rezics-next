import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { RealmRankingsIncomplete, RealmThreadRankingProjection, realmRankPage } from '../src/modules/rankings/realm-threads.ts';
import type { FeedCheckpoint } from '../src/modules/feed/store.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import { RealmReplyStale, RealmReplyUnavailable, type PlacementPreparation,
  type RealmReplyContentStore } from '../src/modules/realm-reply/content-store.ts';
import { replyReceiptIri } from '../src/modules/realm-reply/graph.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { appendContentEvent, sequenceContentEvents } from '../../content/src/event-sequencer.ts';

const root = resolve(import.meta.dir, '../../..');
const epoch = randomUUID();
const contentEpoch = randomUUID();
const native = () => `https://rezics.com/id/${randomUUID()}`;
let cluster: PostgresCluster | undefined;
let access: Pool;
let nativeContent: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster({ serverSettings: `logging_collector=on
log_destination='jsonlog'
log_directory='logs'
log_filename='admission.log'
log_rotation_age=0` });
  access = new Pool({ ...cluster.connection, max: 2 });
  for (const file of schemaFiles(root, 'access')) {
    await access.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
  await access.query('CREATE DATABASE realm_ranking_content');
  nativeContent = new Pool({ ...cluster.connection, database: 'realm_ranking_content', max: 2 });
  for (const file of schemaFiles(root, 'content')) {
    await nativeContent.query(readFileSync(join(root, 'services/content/migrations', file), 'utf8'));
  }
  for (const file of schemaFiles(root, 'relay')) {
    await nativeContent.query(readFileSync(join(root, 'services/main/migrations/relay', file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  await nativeContent?.end();
  await access?.end();
  cluster?.remove();
});

beforeEach(async () => {
  await nativeContent.query('TRUNCATE content.variant,content.receipt CASCADE');
  await nativeContent.query('TRUNCATE relay.delivered_event');
  await nativeContent.query('UPDATE content.owner_control SET data_epoch=$1,sequence=7 WHERE singleton', [contentEpoch]);
  await access.query(`TRUNCATE access.realm_thread_reference, access.realm_thread_state,
    access.realm_thread_population, access.realm_thread_dirty, access.feed_item CASCADE`);
  await access.query(`INSERT INTO access.realm_thread_checkpoint
    (data_epoch,sequence,after_event,content_epoch,content_sequence) VALUES($1,3,'￿',$2,7)
    ON CONFLICT(data_epoch) DO UPDATE SET sequence=3,after_event='￿',content_epoch=$2,content_sequence=7`,
  [epoch, contentEpoch]);
  await access.query('UPDATE access.recovery_fence SET open=true WHERE id');
});

function reader(contentSequence = '7', mainSequence = '3') {
  let contentReads = 0;
  const content = {
    query: async () => {
      contentReads++;
      return { rows: [{ data_epoch: contentEpoch, sequence: contentSequence }] };
    },
  } as unknown as Pool;
  const session = {
    // This diagnostic is deliberately outside both stream comparison domains.
    position: { dataEpoch: epoch, sequence: '100' },
    deps: {
      relayPosition: { read: async () => ({ streamScope: MAIN_RELAY_STREAM_SCOPE,
        dataEpoch: epoch, sequence: mainSequence }) },
      realmReplyThreads: new RealmReplyThreadStore(content, access),
    },
  } as unknown as WorkReadSession;
  return { session, contentReads: () => contentReads };
}

async function reference(realm: string, parent: string | null = null, work = native()) {
  const reply = native(), placement = native();
  await access.query(`INSERT INTO access.realm_thread_reference
    (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp(),true)`,
  [epoch, realm, reply, placement, parent, parent ?? reply, work]);
  return { reply, placement, work };
}

async function pending(realm: string, placement = native()) {
  await access.query(`INSERT INTO access.feed_item
    (data_epoch,id,sequence,kind,occurred_at,time_basis,best_key,realm,group_bucket,group_key,
      group_leader,group_members,sort_time) VALUES($1,$2,4,'reply',clock_timestamp(),'relay',0,$3,
      $2,$2,true,ARRAY[$2],clock_timestamp())`, [epoch, placement, realm]);
}

async function dirty(kind: 'realm' | 'reply' | 'parent' | 'work' | 'placement', resource: string) {
  await access.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [epoch, kind, resource]);
}

async function history(realm: string, replies: string[], population = randomUUID()) {
  await access.query(`INSERT INTO access.realm_thread_population
    (data_epoch,realm,population,floor_epoch,floor_sequence,ready) VALUES($1,$2,$3,$1,0,true)`,
  [epoch, realm, population]);
  for (const reply of replies) {
    await access.query(`INSERT INTO access.realm_thread_population_admission
      VALUES($1,$2,$3,$4,true)`, [epoch, realm, population, reply]);
    await access.query(`INSERT INTO access.realm_thread_private_order
      SELECT data_epoch,realm,$3,sort,period,reply,placement,rank_key,time_key,expires_at
      FROM access.realm_thread_order WHERE data_epoch=$1 AND realm=$2 AND reply=$4`,
    [epoch, realm, population, reply]);
  }
  return population;
}

for (const sort of ['best', 'top'] as const) {
  test(`${sort}: dirty Realm B and Main/Content additions leave established A readable`, async () => {
    const a = native(), b = native();
    const established = await reference(a), unrelated = await reference(b);
    const first = await realmRankPage(access, reader().session, a, sort, 'all', 20);
    await pending(b);
    for (const [kind, resource] of [['realm', b], ['reply', unrelated.reply],
      ['work', unrelated.work], ['parent', unrelated.reply]] as const) await dirty(kind, resource);
    const next = await realmRankPage(access, reader('8', '4').session, a, sort, 'all', 20);
    expect(next).toEqual(first);
    expect(next.rows.map(row => row.reply)).toEqual([established.reply]);
  });

  test(`${sort}: an unprojected addition in A stays absent from its published cut`, async () => {
    const realm = native(), existing = await reference(realm);
    const first = await realmRankPage(access, reader().session, realm, sort, 'all', 20);
    await pending(realm);
    const next = await realmRankPage(access, reader('8', '4').session, realm, sort, 'all', 20);
    expect(next).toEqual(first);
    expect(next.rows.map(row => row.reply)).toEqual([existing.reply]);
  });

  test(`${sort}: pending removals of A's placement, Work, Realm and aggregate child fence only A`, async () => {
    for (const kind of ['reply', 'work', 'realm', 'parent'] as const) {
      const a = native(), b = native();
      const item = await reference(a), other = await reference(b);
      const child = await reference(a, item.reply, item.work);
      await dirty(kind, kind === 'realm' ? a : kind === 'work' ? item.work
        : kind === 'parent' ? item.reply : child.reply);
      await expect(realmRankPage(access, reader().session, a, sort, 'all', 20))
        .rejects.toBeInstanceOf(RealmRankingsIncomplete);
      const page = await realmRankPage(access, reader().session, b, sort, 'all', 20);
      expect(page.rows.map(row => row.reply)).toEqual([other.reply]);
    }
  });
}

test('a reply added to an admitted thread while a page is established still returns 200 with the previous revision', async () => {
  const realm = native(), item = await reference(realm);
  const established = new Map<'best' | 'top', Awaited<ReturnType<typeof realmRankPage>>>();
  for (const sort of ['best', 'top'] as const) {
    established.set(sort, await realmRankPage(access, reader().session, realm, sort, 'all', 20));
  }
  const reply = native(), placement = native();
  // Replay the Content addition through the real projection owner. Its new
  // identity belongs under this admitted root but has no published reference.
  const content = {
    query: async (sql: string) => {
      if (sql.includes('content.owner_control')) return { rows: [{ data_epoch: contentEpoch, sequence: '8' }] };
      if (sql.includes('FROM content.outbox')) return { rows: [{ sequence: '8', reply, resource: item.work,
        realm: null, effect: 'addition', event_type: 'content.reply.created' }] };
      throw new Error('A pending reply addition read an unrelated Content population');
    },
  } as unknown as Pool;
  const { session } = reader('8', '4');
  session.deps.realmReplyThreads = new RealmReplyThreadStore(content, access);
  session.deps.content = {} as NonNullable<WorkReadSession['deps']['content']>;
  const projection = new RealmThreadRankingProjection(access, {} as Pool);
  await expect(projection.tick(session, { data_epoch: epoch } as FeedCheckpoint, '3')).resolves.toBe(true);
  expect((await access.query(`SELECT 1 FROM access.realm_thread_dirty
    WHERE data_epoch=$1 AND kind='reply' AND resource=$2`, [epoch, reply])).rowCount).toBe(1);
  await pending(realm, placement);
  // The immutable placement addition still awaits the exact child delta;
  // it must neither change nor close the already published root population.
  await access.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource,after_key)
    VALUES($1,'placement',$2,'ready:replay') ON CONFLICT DO NOTHING`, [epoch, `${realm}|${reply}`]);
  for (const sort of ['best', 'top'] as const) {
    const previous = established.get(sort)!;
    expect(await realmRankPage(access, session, realm, sort, 'all', 20)).toEqual(previous);
    const anchor = previous.rows[0]!;
    expect(await realmRankPage(access, session, realm, sort, 'all', 20, {
      rank: anchor.rank_key, time: anchor.time_key, placement: anchor.placement, revision: previous.revision,
    })).toEqual({ revision: previous.revision, rows: [] });
  }
  await expect(session.deps.realmReplyThreads.assertThreadProjection(session, realm, item.reply))
    .resolves.toBeUndefined();
  expect(await session.deps.realmReplyThreads.siblingPage(epoch, realm, item.reply, 'new', 20)).toEqual([]);
});

test.each([
  ['content.realm-reply.prepared', 'publication.prepare', 'succeeded', 'addition'],
  ['content.publication.prepared', 'publication.prepare', 'succeeded', 'addition'],
  ['content.revision.saved', 'draft.save', 'succeeded', 'addition'],
  ['content.comment.created', 'comment.create', 'succeeded', 'addition'],
  ['content.publication.active', 'publication.settle', 'succeeded', 'addition'],
  ['content.publication.rejected', 'publication.settle', 'succeeded', 'removal'],
  ['content.realm-reply.prepared', 'publication.prepare', 'rejected', 'none'],
  ['content.draft.stale', 'draft.save', 'stale_head', 'none'],
  ['content.unknown', 'publication.prepare', 'succeeded', 'removal'],
] as const)('native Content replay classifies %s (%s, %s) as %s', async (eventType, action, outcome, effect) => {
  const realm = native(), item = await reference(realm);
  const otherRealm = native(), other = await reference(otherRealm);
  const variant = `reply:${randomUUID()}`, creation = randomUUID(), draft = randomUUID();
  await nativeContent.query(`INSERT INTO content.variant (id,resource_id,language_kind,direction)
    VALUES($1,$2,'missing','none')`, [variant, item.reply]);
  const record = async (operationId: string, eventType: string, action: string,
    outcome: 'succeeded' | 'rejected' | 'stale_head') => {
    const client = await nativeContent.connect();
    try {
      await appendContentEvent(client, { operationId, requestDigest: 'a'.repeat(64), action, outcome,
        variantId: variant, eventType, recipe: 'realm-reply-v1', payload: { realm, reply: item.reply } });
    } finally { client.release(); }
    await sequenceContentEvents(nativeContent);
  };
  const actor = native(), rootRevision = native();
  await record(draft, 'content.revision.saved', 'draft.save', 'succeeded');
  await nativeContent.query(`INSERT INTO content.reply_author
    (reply,variant_id,author,root_target,root_revision,operation_id) VALUES($1,$2,$3,$4,$5,$6)`,
  [item.reply, variant, actor, item.work, rootRevision, draft]);
  await record(creation, 'content.reply.created', 'reply.create', 'succeeded');
  await nativeContent.query(`INSERT INTO content.reply
    (id,variant_id,author,root_target,root_revision,operation_id) VALUES($1,$2,$3,$4,$5,$6)`,
  [item.reply, variant, actor, item.work, rootRevision, creation]);
  await access.query('UPDATE access.realm_thread_checkpoint SET content_sequence=9 WHERE data_epoch=$1', [epoch]);
  const { session } = reader('9', '3');
  session.deps.realmReplyThreads = new RealmReplyThreadStore(nativeContent, access);
  session.deps.content = {} as NonNullable<WorkReadSession['deps']['content']>;
  const previous = new Map<'best' | 'top', Awaited<ReturnType<typeof realmRankPage>>>();
  for (const sort of ['best', 'top'] as const) {
    previous.set(sort, await realmRankPage(access, session, realm, sort, 'all', 20));
  }
  // Exercise the production join and CASE against the owner's migrated receipt
  // and outbox tables. A stubbed effect cannot hide a missing receipt family.
  await record(randomUUID(), eventType, action, outcome);
  await expect(new RealmThreadRankingProjection(access, {} as Pool)
    .tick(session, { data_epoch: epoch } as FeedCheckpoint, '3')).resolves.toBe(true);
  expect((await access.query('SELECT effect FROM access.realm_thread_dirty WHERE data_epoch=$1 AND resource=$2',
    [epoch, item.reply])).rows).toEqual(effect === 'none' ? [] : [{ effect }]);
  for (const sort of ['best', 'top'] as const) {
    if (effect !== 'removal') {
      expect(await realmRankPage(access, session, realm, sort, 'all', 20)).toEqual(previous.get(sort)!);
    } else {
      await expect(realmRankPage(access, session, realm, sort, 'all', 20)).rejects.toBeInstanceOf(RealmRankingsIncomplete);
    }
    expect((await realmRankPage(access, session, otherRealm, sort, 'all', 20)).rows.map(row => row.reply)).toEqual([other.reply]);
  }
});

test.each(['rejected', undefined, 'future-outcome'] as const)(
  'native Main replay consumes %s receipts without mistaking unknown outcomes for refusals', async outcome => {
    const realm = native(), item = await reference(realm), otherRealm = native();
    const other = await reference(otherRealm);
    await nativeContent.query(`INSERT INTO relay.delivered_event
      (stream_scope,source,event_id,data_epoch,sequence,envelope) VALUES($1,'realm-ranking', $2,$3,4,$4)`,
    [MAIN_RELAY_STREAM_SCOPE, randomUUID(), epoch, JSON.stringify({ type: 'com.rezics.realm.reply-placed.v1',
      data: { receipt: { realm, reply: item.reply, action: 'reply.place', outcome } } })]);
    const { session } = reader('7', '4');
    session.deps.realmReplyThreads = new RealmReplyThreadStore(nativeContent, access);
    session.deps.content = {} as NonNullable<WorkReadSession['deps']['content']>;
    const previous = await realmRankPage(access, session, realm, 'best', 'all', 20);
    await expect(new RealmThreadRankingProjection(access, nativeContent)
      .tick(session, { data_epoch: epoch } as FeedCheckpoint, '4')).resolves.toBe(true);
    expect((await access.query('SELECT sequence::text FROM access.realm_thread_checkpoint WHERE data_epoch=$1',
      [epoch])).rows[0]).toEqual({ sequence: '4' });
    if (outcome === 'rejected') {
      expect(await realmRankPage(access, session, realm, 'best', 'all', 20)).toEqual(previous);
      expect((await access.query('SELECT 1 FROM access.realm_thread_dirty WHERE data_epoch=$1', [epoch])).rowCount).toBe(0);
    } else {
      await expect(realmRankPage(access, session, realm, 'best', 'all', 20)).rejects.toBeInstanceOf(RealmRankingsIncomplete);
    }
    expect((await realmRankPage(access, session, otherRealm, 'best', 'all', 20)).rows.map(row => row.reply)).toEqual([other.reply]);
  });

test('uninitialized and reset placements never masquerade as a complete empty population', async () => {
  const realm = native();
  await pending(realm);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 20))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  const existing = await reference(native());
  const indexedRealm = (await access.query<{ realm: string }>(
    'SELECT realm FROM access.realm_thread_reference WHERE reply=$1', [existing.reply])).rows[0]!.realm;
  await pending(indexedRealm, existing.placement);
  await access.query('UPDATE access.feed_item SET realm_thread_indexed=false WHERE data_epoch=$1 AND id=$2',
    [epoch, existing.placement]);
  await expect(realmRankPage(access, reader().session, indexedRealm, 'best', 'all', 20))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  expect((await realmRankPage(access, reader().session, native(), 'best', 'all', 20)).rows).toEqual([]);
});

test('private-history initialization, dependencies and additions are population scoped', async () => {
  const realm = native(), admitted = await reference(realm), excluded = await reference(realm);
  const population = await history(realm, [admitted.reply]);
  await dirty('reply', excluded.reply);
  const addition = await reference(realm);
  expect((await access.query(`SELECT 1 FROM access.realm_thread_population_job
    WHERE data_epoch=$1 AND realm=$2 AND population=$3 AND reply=$4`,
  [epoch, realm, population, addition.reply])).rowCount).toBe(1);
  const page = await realmRankPage(access, reader().session, realm, 'top', 'all', 20, undefined, population);
  expect(page.rows.map(row => row.reply)).toEqual([admitted.reply]);
  await dirty('reply', admitted.reply);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 20, undefined, population))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  await access.query('DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1', [epoch]);
  await access.query('UPDATE access.realm_thread_population SET ready=false WHERE population=$1', [population]);
  for (const cut of [population, randomUUID()]) {
    await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 20, undefined, cut))
      .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  }
});

test('expiration fences only the requested Top period and admitted private population', async () => {
  const realm = native(), visible = await reference(realm), hidden = await reference(realm);
  const population = await history(realm, [visible.reply]);
  await access.query(`UPDATE access.realm_thread_order SET expires_at=clock_timestamp()-interval '1 second'
    WHERE data_epoch=$1 AND realm=$2 AND reply=$3 AND sort='top' AND period='week'`, [epoch, realm, hidden.reply]);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'week', 20))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  const privatePage = await realmRankPage(access, reader().session, realm, 'top', 'week', 20, undefined, population);
  expect(privatePage.rows.map(row => row.reply)).toEqual([visible.reply]);
  for (const sort of ['best', 'top'] as const) {
    expect((await realmRankPage(access, reader().session, realm, sort, 'all', 20)).rows).toHaveLength(2);
  }
  await access.query(`UPDATE access.realm_thread_private_order SET expires_at=clock_timestamp()-interval '1 second'
    WHERE data_epoch=$1 AND realm=$2 AND population=$3 AND sort='top' AND period='week'`, [epoch, realm, population]);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'week', 20, undefined, population))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
});

test('a dirty root outside the requested period cannot close the remaining Top cut', async () => {
  const realm = native(), current = await reference(realm), old = await reference(realm);
  await access.query(`UPDATE access.realm_thread_reference SET occurred_at=clock_timestamp()-interval '40 days'
    WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, old.reply]);
  await dirty('reply', old.reply);
  const page = await realmRankPage(access, reader().session, realm, 'top', 'week', 20);
  expect(page.rows.map(row => row.reply)).toEqual([current.reply]);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 20))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
});

test('recovery and revision changes refuse both first pages and continuations', async () => {
  const realm = native();
  await reference(realm);
  const first = await realmRankPage(access, reader().session, realm, 'top', 'all', 1);
  const key = { rank: first.rows[0]!.rank_key, time: first.rows[0]!.time_key,
    placement: first.rows[0]!.placement, revision: first.revision };
  await dirty('realm', realm);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 1, key))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  await access.query('DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1', [epoch]);
  await reference(realm);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 1, key))
    .rejects.toBeInstanceOf(WorkReadMoved);
  await access.query('UPDATE access.recovery_fence SET open=false WHERE id');
  for (const after of [undefined, key]) {
    await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 1, after))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});

test('thread admission also survives unrelated Realm additions at established stream cuts', async () => {
  const a = native(), b = native();
  const item = await reference(a);
  await pending(b);
  const { session } = reader('8', '4');
  // The writer-owned thread gate is part of the same acceptance rule.
  await expect(session.deps.realmReplyThreads!.assertThreadProjection(session, a, item.reply)).resolves.toBeUndefined();
});

test('thread admission fences only the selected neighbourhood inside one Realm', async () => {
  const a = native(), b = native();
  const first = await reference(a), second = await reference(a), other = await reference(b);
  const firstChild = await reference(a, first.reply, first.work);
  const secondChild = await reference(a, second.reply, second.work);
  const { session } = reader('8', '4');
  const ready = (realm: string, reply: string) => session.deps.realmReplyThreads!
    .assertThreadProjection(session, realm, reply, undefined,
      reply === first.reply ? [reply, firstChild.reply] : reply === second.reply ? [reply, secondChild.reply] : [reply]);
  await dirty('reply', secondChild.reply);
  await expect(ready(a, first.reply)).resolves.toBeUndefined();
  await expect(ready(a, firstChild.reply)).resolves.toBeUndefined();
  await expect(ready(b, other.reply)).resolves.toBeUndefined();
  await expect(ready(a, second.reply)).rejects.toBeInstanceOf(WorkReadUnavailable);
  await access.query('DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1', [epoch]);
  await dirty('reply', firstChild.reply);
  await expect(ready(a, first.reply)).rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(ready(a, second.reply)).resolves.toBeUndefined();
  await expect(ready(b, other.reply)).resolves.toBeUndefined();
});

test('deleting a placed parent queues child propagation only in that Realm', async () => {
  const a = native(), b = native(), parent = await reference(a);
  const child = await reference(a, parent.reply, parent.work);
  await access.query(`INSERT INTO access.realm_thread_reference
    (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,active)
    VALUES($1,$2,$3,$4,NULL,$3,$5,clock_timestamp(),clock_timestamp(),true)`,
  [epoch, b, parent.reply, native(), parent.work]);
  const otherChild = await reference(b, parent.reply, parent.work);
  await access.query(`DELETE FROM access.realm_thread_reference
    WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, a, parent.reply]);
  expect((await access.query<{ kind: string; resource: string; after_key: string }>(`SELECT kind,resource,after_key
    FROM access.realm_thread_dirty WHERE data_epoch=$1`, [epoch])).rows)
    .toEqual([{ kind: 'placement', resource: `${a}|${parent.reply}`, after_key: 'children:' }]);
  expect((await realmRankPage(access, reader().session, b, 'top', 'all', 20)).rows.map(row => row.reply))
    .toEqual([parent.reply]);
  const { session } = reader();
  await expect(session.deps.realmReplyThreads!.assertThreadProjection(session, a, child.reply))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(session.deps.realmReplyThreads!.assertThreadProjection(session, b, otherChild.reply))
    .resolves.toBeUndefined();
});

for (const aggregate of [false, true]) {
  test(`acknowledged ${aggregate ? 'child' : 'root'} review removal fences A before replay and leaves B open`, async () => {
    const a = native(), b = native();
    const item = await reference(a), other = await reference(b);
    const removed = aggregate ? await reference(a, item.reply, item.work) : item;
    // A Realm-local review of one Content identity must not fence that
    // identity's independent approved placement in another Realm.
    await access.query(`INSERT INTO access.realm_thread_reference
      (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,active)
      VALUES($1,$2,$3,$4,NULL,$3,$5,clock_timestamp(),clock_timestamp(),true)`,
    [epoch, b, removed.reply, native(), native()]);
    if (aggregate) await access.query(`UPDATE access.realm_thread_reference SET replies=1
      WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, a, item.reply]);
    const admission: RegisteredAdmission = {
      id: randomUUID(), principalId: randomUUID(), actingSubject: native(),
      scope: `review:decide:${a}`, action: 'review.decide', idempotencyKey: randomUUID(),
      requestDigest: 'a'.repeat(64), authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false,
    };
    // Keep the actual registry's owner pool. Only admission and the external
    // Content/graph boundaries are deterministic in this owner-level proof.
    const registry = new AccessAdmissionRegistry(access);
    let fencedBeforeContent = false, fencedThroughAcknowledgement = false;
    const exactFence = async () => (await access.query(`SELECT 1 FROM access.realm_thread_dirty
      WHERE data_epoch=$1 AND kind='placement' AND resource=$2`,
    [epoch, `${a}|${removed.reply}|${admission.id}`])).rowCount === 1;
    Object.assign(registry, {
      register: async () => admission, claim: async () => admission,
      recordGraphOutcome: async () => {
        fencedThroughAcknowledgement = await exactFence();
        expect(fencedThroughAcknowledgement).toBe(true);
        await expect(realmRankPage(access, reader('8', '4').session, a, 'top', 'all', 20))
          .rejects.toBeInstanceOf(RealmRankingsIncomplete);
      },
    });
    let terminal = false, revoked = false;
    const content = {
      hasReceipt: async () => false,
      decideReview: async () => {
        fencedBeforeContent = await exactFence();
        expect(fencedBeforeContent).toBe(true);
        revoked = true;
        return { decisionId: randomUUID(), realm: a, reply: removed.reply, revisionId: randomUUID(),
          generation: '2', outcome: 'revoked', revisionDigest: 'b'.repeat(64), replayed: false };
      },
    } as unknown as RealmReplyContentStore;
    const env = {
      lineage: { dataEpoch: epoch, routingEpoch: contentEpoch },
      fuseki: {
        query: async (sql: string) => {
          if (sql.includes('ASK')) return { boolean: true };
          const values = { outcome: `${RV}Succeeded`, digest: admission.requestDigest, id: admission.id,
            epoch: admission.authorityEpoch, scope: admission.scope, dataEpoch: epoch, sequence: '101' };
          return { results: { bindings: terminal ? [Object.fromEntries(Object.entries(values)
            .map(([key, value]) => [key, { type: 'literal', value }]))] : [] } };
        },
        commandWithReceipt: async () => { terminal = true; },
      },
    } as unknown as WorkActivationEnvironment;
    await new RealmReplyStore(content, {} as ConstructorParameters<typeof RealmReplyStore>[1], registry, env, access)
      .review({ issuer: 'https://account.test', subject: admission.principalId }, admission.actingSubject, {
        realm: a, reply: removed.reply, revisionId: randomUUID(), revisionDigest: 'b'.repeat(64),
        expectedGeneration: '1', supersedes: randomUUID(), outcome: 'revoked', method: 'human',
        methodRevision: 'human-review-v1', dependencyDigest: 'c'.repeat(64), reasonReference: 'withdrawn',
      }, admission.idempotencyKey, admission.requestDigest);
    expect(revoked).toBe(true);
    expect(fencedBeforeContent).toBe(true);
    expect(fencedThroughAcknowledgement).toBe(true);
    const unaffected = await realmRankPage(access, reader('8', '4').session, b, 'top', 'all', 20);
    expect(new Set(unaffected.rows.map(row => row.reply))).toEqual(new Set([other.reply, removed.reply]));
    // A root surviving its child's removal still needs a settled aggregate.
    let affected;
    try { affected = await realmRankPage(access, reader('8', '4').session, a, 'top', 'all', 20); }
    catch (error) {
      expect(error).toBeInstanceOf(RealmRankingsIncomplete);
      return;
    }
    if (!aggregate) expect(affected.rows.map(row => row.reply)).not.toContain(removed.reply);
    else if (affected.rows.some(row => row.reply === item.reply)) {
      const state = (await access.query<{ active: boolean; replies: number }>(`SELECT child.active,root.replies
        FROM access.realm_thread_reference child JOIN access.realm_thread_reference root
          ON root.data_epoch=child.data_epoch AND root.realm=child.realm AND root.reply=child.thread
        WHERE child.data_epoch=$1 AND child.realm=$2 AND child.reply=$3`, [epoch, a, removed.reply])).rows[0]!;
      expect(state.active).toBe(false);
      expect(state.replies).toBe(0);
    }
  });
}

test('a refused concurrent review preserves the pending removal owned by another admission', async () => {
  const a = native(), b = native(), item = await reference(a), other = await reference(b);
  const admissions = [0, 1].map((): RegisteredAdmission => ({
    id: randomUUID(), principalId: randomUUID(), actingSubject: native(),
    scope: `review:decide:${a}`, action: 'review.decide', idempotencyKey: randomUUID(),
    requestDigest: 'a'.repeat(64), authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: false,
  }));
  const first = admissions[0]!, second = admissions[1]!;
  let enterContent!: () => void, releaseContent!: () => void;
  const entered = new Promise<void>(resolveEntered => { enterContent = resolveEntered; });
  const blocked = new Promise<void>(resolveBlocked => { releaseContent = resolveBlocked; });
  const content = {
    hasReceipt: async () => false,
    decideReview: async (admission: RegisteredAdmission) => {
      if (admission.id === second.id) throw new RealmReplyStale('Review generation changed');
      enterContent();
      await blocked;
      return { decisionId: randomUUID(), realm: a, reply: item.reply, revisionId: randomUUID(),
        generation: '2', outcome: 'revoked', revisionDigest: 'b'.repeat(64), replayed: false };
    },
  } as unknown as RealmReplyContentStore;
  const terminals = new Set<string>();
  const env = {
    lineage: { dataEpoch: epoch, routingEpoch: contentEpoch },
    fuseki: {
      query: async (sql: string) => {
        if (sql.includes('ASK')) return { boolean: true };
        const admission = admissions.find(candidate => sql.includes(replyReceiptIri(candidate)));
        if (!admission) throw new Error('Review read an unrelated graph inventory');
        const values = { outcome: `${RV}Succeeded`, digest: admission.requestDigest, id: admission.id,
          epoch: admission.authorityEpoch, scope: admission.scope, dataEpoch: epoch, sequence: '101' };
        return { results: { bindings: terminals.has(admission.id) ? [Object.fromEntries(Object.entries(values)
          .map(([key, value]) => [key, { type: 'literal', value }]))] : [] } };
      },
      commandWithReceipt: async ({ receipt }: { receipt: string }) => {
        const admission = admissions.find(candidate => replyReceiptIri(candidate) === receipt);
        if (!admission) throw new Error('Review dispatched an unrelated graph command');
        terminals.add(admission.id);
      },
    },
  } as unknown as WorkActivationEnvironment;
  const registry = new AccessAdmissionRegistry(access);
  Object.assign(registry, {
    register: async ({ idempotencyKey }: { idempotencyKey: string }) =>
      admissions.find(admission => admission.idempotencyKey === idempotencyKey)!,
    claim: async (id: string) => admissions.find(admission => admission.id === id)!,
    recordGraphOutcome: async () => undefined,
  });
  const store = new RealmReplyStore(content, {} as ConstructorParameters<typeof RealmReplyStore>[1], registry, env, access);
  const review = (admission: RegisteredAdmission) => store.review({ issuer: 'https://account.test', subject: admission.principalId },
    admission.actingSubject, { realm: a, reply: item.reply, revisionId: randomUUID(), revisionDigest: 'b'.repeat(64),
      expectedGeneration: '1', supersedes: randomUUID(), outcome: 'revoked', method: 'human',
      methodRevision: 'human-review-v1', dependencyDigest: 'c'.repeat(64), reasonReference: 'withdrawn' },
    admission.idempotencyKey, admission.requestDigest);
  const firstOutcome = review(first).then(value => ({ value }), error => ({ error }));
  let outcome: Awaited<typeof firstOutcome> | undefined;
  try {
    await Promise.race([entered, firstOutcome.then(result => {
      throw 'error' in result ? result.error : new Error('First review never reached its Content transition');
    })]);
    await expect(review(second)).rejects.toBeInstanceOf(RealmReplyStale);
    const jobs = (await access.query<{ resource: string; after_key: string }>(`SELECT resource,after_key
      FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='placement'`, [epoch])).rows;
    expect(jobs).toEqual([{ resource: `${a}|${item.reply}|${first.id}`, after_key: `pending:${first.id}` }]);
    await expect(realmRankPage(access, reader().session, a, 'top', 'all', 20))
      .rejects.toBeInstanceOf(RealmRankingsIncomplete);
    expect((await realmRankPage(access, reader().session, b, 'top', 'all', 20)).rows.map(row => row.reply))
      .toEqual([other.reply]);
    const { session } = reader();
    await expect(session.deps.realmReplyThreads!.assertThreadProjection(session, a, item.reply))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
    await expect(session.deps.realmReplyThreads!.assertThreadProjection(session, b, other.reply))
      .resolves.toBeUndefined();
  } finally {
    releaseContent();
    outcome = await firstOutcome;
  }
  expect(outcome && 'error' in outcome ? outcome.error : undefined).toBeUndefined();
  expect((await access.query<{ resource: string; after_key: string }>(`SELECT resource,after_key
    FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='placement'`, [epoch])).rows)
    .toEqual([{ resource: `${a}|${item.reply}|${first.id}`, after_key: `ready:${first.id}` }]);
  await expect(realmRankPage(access, reader().session, a, 'top', 'all', 20))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  expect((await realmRankPage(access, reader().session, b, 'top', 'all', 20)).rows.map(row => row.reply))
    .toEqual([other.reply]);
});

/** The graph already accepted this admission. Retrying the actual owner
 * command must finish its local publication without dispatching or draining
 * other Realm jobs. Access remains real, including ranking triggers. */
function placementReplay(realm: string, parent: string | null, work: string, owner = access) {
  const reply = native(), placement = native(), revisionId = randomUUID();
  const admission: RegisteredAdmission = {
    id: randomUUID(), principalId: randomUUID(), actingSubject: native(),
    scope: `reply:place:${realm}`, action: 'reply.place', idempotencyKey: randomUUID(),
    requestDigest: 'd'.repeat(64), authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: true,
  };
  const prepared: PlacementPreparation = {
    operationId: admission.id, realm, reply, revisionId, revisionDigest: 'e'.repeat(64),
    reviewDecisionId: randomUUID(), reviewGeneration: '1', reviewDigest: 'f'.repeat(64),
    author: admission.actingSubject, ownerDataEpoch: contentEpoch, ownerSequence: '8',
    rootTarget: work, rootRevision: native(), parentReply: parent,
    parentRevision: parent ? randomUUID() : null, contextRevision: null, replayed: true,
  };
  let graphRequests = 0, contentSettlements = 0;
  const content = {
    hasReceipt: async () => true,
    readPlacement: async () => prepared,
  } as unknown as RealmReplyContentStore;
  const env = {
    lineage: { dataEpoch: epoch, routingEpoch: contentEpoch },
    fuseki: {
      query: async (sql: string) => {
        graphRequests++;
        if (sql.includes('ASK')) return { boolean: true };
        if (sql.includes('?outcome ?digest ?id ?epoch')) {
          const values = { outcome: `${RV}Succeeded`, digest: admission.requestDigest, id: admission.id,
            epoch: admission.authorityEpoch, scope: admission.scope, dataEpoch: epoch, sequence: '101',
            placement, revision: `urn:rezics:content:revision:${revisionId}`, realm, reply };
          return { results: { bindings: [Object.fromEntries(Object.entries(values)
            .map(([key, value]) => [key, { type: 'literal', value }]))] } };
        }
        if (sql.includes('SELECT ?space ?realmRevision ?disclosure')) return { results: { bindings: [{
          space: { type: 'uri', value: native() }, disclosure: { type: 'uri', value: `${RV}Public` },
        }] } };
        throw new Error('Placement performed an unrelated graph inventory read');
      },
      commandWithReceipt: async () => {
        graphRequests++;
        throw new Error('A known terminal placement must not dispatch another graph command');
      },
    },
  } as unknown as WorkActivationEnvironment;
  const registry = {
    register: async () => admission, claim: async () => ({ ...admission, claimedAt: new Date().toISOString() }),
    recordGraphOutcome: async () => undefined,
  };
  const store = new RealmReplyStore(content, {
    settlePublication: async () => { contentSettlements++; },
  } as unknown as ConstructorParameters<typeof RealmReplyStore>[1], registry, env, owner);
  const place = () => store.place({ issuer: 'https://account.test', subject: admission.principalId },
    admission.actingSubject, { realm, reply, revisionId, revisionDigest: prepared.revisionDigest,
      reviewDecisionId: prepared.reviewDecisionId, expectedHead: null }, admission.idempotencyKey, admission.requestDigest);
  return { place, reply, placement, graphRequests: () => graphRequests,
    contentSettlements: () => contentSettlements };
}

test('an acknowledged first root placement is immediately present in its Best and Top populations', async () => {
  const realm = native(), command = placementReplay(realm, null, native());
  await pending(realm, command.placement);
  await expect(command.place()).resolves.toMatchObject({ placement: command.placement });
  for (const sort of ['best', 'top'] as const) {
    expect((await realmRankPage(access, reader('8', '4').session, realm, sort, 'all', 20))
      .rows.map(row => row.reply)).toEqual([command.reply]);
  }
  const { session } = reader('8', '4');
  await expect(session.deps.realmReplyThreads!.assertThreadProjection(session, realm, command.reply))
    .resolves.toBeUndefined();
});

for (const [source, removal] of [
  ['content', false], ['content', true], ['main', false], ['main', true],
] as const) {
  test(removal ? `an additive ${source} replay preserves an outstanding removal of the same indexed child`
    : `an indexed child addition keeps its published cut readable while ${source} replay is pending`, async () => {
    const realm = native(), parent = await reference(realm);
    const unaffectedRealm = native(), unaffected = await reference(unaffectedRealm);
    const command = placementReplay(realm, parent.reply, parent.work);
    await expect(command.place()).resolves.toMatchObject({ placement: command.placement });
    const established = new Map<'best' | 'top', Awaited<ReturnType<typeof realmRankPage>>>();
    for (const sort of ['best', 'top'] as const) {
      established.set(sort, await realmRankPage(access, reader('8', '4').session, realm, sort, 'all', 20));
    }
    if (source === 'main') await access.query(`UPDATE access.realm_thread_checkpoint
      SET content_sequence=8 WHERE data_epoch=$1`, [epoch]);
    const ownerSequence = source === 'content' ? '9' : '8';
    const operation = randomUUID();
    const removalKind = source === 'content' ? 'reply' : 'placement';
    const removalResource = source === 'content' ? command.reply : `${realm}|${command.reply}`;
    const removalAfter = source === 'content' ? '' : `pending:${operation}`;
    const interleaveRemoval = async () => {
      if (!removal) return;
      // The authoritative removal arrives after the worker chose source
      // replay, while its external owner read is in flight. Its durable row
      // must win the later additive upsert, including a pending operation.
      await access.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource,after_key,effect)
        VALUES($1,$2,$3,$4,'removal')`, [epoch, removalKind, removalResource, removalAfter]);
    };
    const content = {
      query: async (sql: string) => {
        if (sql.includes('content.owner_control')) return { rows: [{ data_epoch: contentEpoch, sequence: ownerSequence }] };
        if (source === 'content' && sql.includes('FROM content.outbox')) {
          expect(sql).toContain('content.reply.created');
          expect(sql).toContain('supersedes');
          await interleaveRemoval();
          return { rows: [
            { sequence: '8', reply: command.reply, resource: parent.work, realm: null, effect: 'addition',
              event_type: 'content.reply.created', operation_id: randomUUID(), payload: { reply: command.reply } },
            { sequence: '9', reply: command.reply, resource: parent.work, realm, effect: 'addition',
              event_type: 'content.realm-review.decided', operation_id: randomUUID(),
              payload: { realm, reply: command.reply, outcome: 'approved', supersedes: null } },
          ] };
        }
        throw new Error('A pure addition replay read an unrelated Content population');
      },
    } as unknown as Pool;
    const relay = {
      query: async (sql: string) => {
        if (!sql.includes('FROM relay.delivered_event')) throw new Error('A pure addition replay read unrelated Main inventory');
        expect(sql).toContain('reply.place');
        expect(sql).toContain('com.rezics.realm.reply-placed.v1');
        await interleaveRemoval();
        return { rows: [{ sequence: '4', event_id: randomUUID(), reply: command.reply, work: parent.work, realm, effect: 'addition',
          event_type: 'realm.reply.placed', action: 'reply.place', predecessor: null,
          envelope: { data: { action: 'reply.place', receipt: { realm, reply: command.reply,
            placement: command.placement, predecessor: null } } } }] };
      },
    } as unknown as Pool;
    const { session } = reader(ownerSequence, '4');
    session.deps.realmReplyThreads = new RealmReplyThreadStore(content, access);
    session.deps.content = {} as NonNullable<WorkReadSession['deps']['content']>;
    await expect(new RealmThreadRankingProjection(access, relay)
      .tick(session, { data_epoch: epoch } as FeedCheckpoint, source === 'main' ? '4' : '3')).resolves.toBe(true);
    const jobs = (await access.query<{ kind: string; resource: string; after_key: string; effect: string }>(
      `SELECT kind,resource,after_key,effect FROM access.realm_thread_dirty
      WHERE data_epoch=$1`, [epoch])).rows;
    expect(jobs.length).toBeGreaterThan(0);
    if (removal) expect(jobs.find(job => job.kind === removalKind && job.resource === removalResource))
      .toEqual({ kind: removalKind, resource: removalResource, after_key: removalAfter, effect: 'removal' });
    else expect(jobs.every(job => job.effect === 'addition')).toBe(true);
    for (const sort of ['best', 'top'] as const) {
      if (removal) await expect(realmRankPage(access, session, realm, sort, 'all', 20))
        .rejects.toBeInstanceOf(RealmRankingsIncomplete);
      else expect(await realmRankPage(access, session, realm, sort, 'all', 20)).toEqual(established.get(sort)!);
      expect((await realmRankPage(access, session, unaffectedRealm, sort, 'all', 20)).rows.map(row => row.reply))
        .toEqual([unaffected.reply]);
    }
    for (const focus of [parent.reply, command.reply]) {
      const ready = session.deps.realmReplyThreads.assertThreadProjection(session, realm, focus, undefined,
        focus === parent.reply ? [focus, command.reply] : [focus]);
      if (removal) await expect(ready).rejects.toBeInstanceOf(WorkReadUnavailable);
      else await expect(ready).resolves.toBeUndefined();
    }
    await expect(session.deps.realmReplyThreads.assertThreadProjection(session, unaffectedRealm, unaffected.reply))
      .resolves.toBeUndefined();
  });
}

test('acknowledged placement publishes its exact index, aggregate, order and revision with bounded work', async () => {
  const unrelated = native();
  const costs: { statements: number; graphRequests: number }[] = [];
  let previous = 0;
  for (const size of [100, 400, 1600]) {
    await access.query(`INSERT INTO access.realm_thread_reference
      (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,active)
      SELECT $1,$2,id,id,NULL,id,$2,clock_timestamp(),clock_timestamp(),true
      FROM (SELECT 'https://rezics.com/id/'||gen_random_uuid() AS id FROM generate_series(1,$3::integer)) refs`,
    [epoch, unrelated, size - previous]);
    await access.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
      SELECT data_epoch,'reply',reply FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2
      ON CONFLICT DO NOTHING`, [epoch, unrelated]);
    const realm = native(), parent = await reference(realm);
    const before = await realmRankPage(access, reader().session, realm, 'top', 'all', 20);
    let statements = 0;
    const owner = {
      query: async (sql: string, values?: unknown[]) => {
        statements++;
        return access.query(sql, values);
      },
      connect: async () => {
        const client = await access.connect();
        return { query: async (sql: string, values?: unknown[]) => {
          statements++;
          return client.query(sql, values);
        }, release: () => client.release() };
      },
    } as unknown as Pool;
    const command = placementReplay(realm, parent.reply, parent.work, owner);
    await pending(realm, command.placement);
    const acknowledged = await command.place();
    costs.push({ statements, graphRequests: command.graphRequests() });
    expect(acknowledged.placement).toBe(command.placement);
    const references = (await access.query<{ reply: string; placement: string; thread: string;
      parent: string | null; active: boolean; replies: number }>(`SELECT reply,placement,thread,parent,active,replies
      FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 ORDER BY reply`, [epoch, realm])).rows;
    expect(references).toHaveLength(2);
    expect(references.find(row => row.reply === command.reply)).toMatchObject({
      placement: command.placement, thread: parent.reply, parent: parent.reply, active: true,
    });
    expect(references.find(row => row.reply === parent.reply)?.replies).toBe(1);
    expect((await access.query<{ indexed: boolean }>(`SELECT realm_thread_indexed AS indexed
      FROM access.feed_item WHERE data_epoch=$1 AND id=$2`, [epoch, command.placement])).rows[0]?.indexed).toBe(true);
    for (const sort of ['best', 'top'] as const) {
      const page = await realmRankPage(access, reader('8', '4').session, realm, sort, 'all', 20);
      expect(page.rows.map(row => row.reply)).toEqual([parent.reply]);
      expect(BigInt(page.revision)).toBeGreaterThan(BigInt(before.revision));
    }
    const after = await realmRankPage(access, reader('8', '4').session, realm, 'top', 'all', 20);
    await expect(command.place()).resolves.toEqual(acknowledged);
    expect(await realmRankPage(access, reader('8', '4').session, realm, 'top', 'all', 20)).toEqual(after);
    expect((await access.query<{ replies: number }>(`SELECT replies FROM access.realm_thread_reference
      WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, parent.reply])).rows[0]!.replies).toBe(1);
    expect(command.contentSettlements()).toBe(2);
    expect((await access.query(`SELECT 1 FROM access.realm_thread_dirty
      WHERE data_epoch=$1 AND kind='reply'`, [epoch])).rowCount).toBe(size);
    previous = size;
  }
  expect(costs[0]!.statements).toBeGreaterThan(0);
  expect(costs[0]!.graphRequests).toBeGreaterThan(0);
  expect(costs).toEqual([costs[0], costs[0], costs[0]]);
});

test('a terminal placement withheld by Access recovery resumes its same exact index on retry', async () => {
  const realm = native(), parent = await reference(realm);
  const command = placementReplay(realm, parent.reply, parent.work);
  await access.query('UPDATE access.recovery_fence SET open=false WHERE id');
  await expect(command.place()).rejects.toBeInstanceOf(RealmReplyUnavailable);
  expect((await access.query(`SELECT 1 FROM access.realm_thread_reference
    WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, command.reply])).rowCount).toBe(0);
  await access.query('UPDATE access.recovery_fence SET open=true WHERE id');
  await expect(command.place()).resolves.toMatchObject({ placement: command.placement });
  expect((await access.query<{ active: boolean; replies: number }>(`SELECT child.active,root.replies
    FROM access.realm_thread_reference child JOIN access.realm_thread_reference root
      ON root.data_epoch=child.data_epoch AND root.realm=child.realm AND root.reply=child.thread
    WHERE child.data_epoch=$1 AND child.realm=$2 AND child.reply=$3`, [epoch, realm, command.reply])).rows[0])
    .toEqual({ active: true, replies: 1 });
});

interface Plan {
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Join Filter'?: number;
  Plans?: Plan[];
}

function visited(plan: Plan): number {
  return (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)
    + (plan['Rows Removed by Join Filter'] ?? 0)) * plan['Actual Loops']
    + (plan.Plans ?? []).reduce((count, child) => count + visited(child), 0);
}

async function loggedPlans(path: string, offset: number, pages: number): Promise<{ 'Query Text': string; Plan: Plan }[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const log = readFileSync(path, 'utf8').slice(offset);
    const plans = log.slice(0, log.lastIndexOf('\n')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { message: string })
      .filter(entry => entry.message.includes('plan:\n'))
      .map(entry => JSON.parse(entry.message.slice(entry.message.indexOf('plan:\n') + 6)) as
        { 'Query Text': string; Plan: Plan });
    if (plans.filter(plan => plan['Query Text'].includes('SELECT * FROM access.read_realm_thread_rank_cut(')).length === pages)
      return plans;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error('The ranking cut did not record its nested SQL plans');
}

test('admission SQL and visited rows stay bounded as unrelated dirty inventory grows', async () => {
  const a = native(), b = native(), empty = native();
  const item = await reference(a);
  const costs: { statements: number; contentReads: number; visited: number }[] = [];
  let previous = 0;
  for (const size of [100, 400, 1600]) {
    await access.query(`INSERT INTO access.realm_thread_reference
      (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,active)
      SELECT $1,$2,id,id,NULL,id,$2,clock_timestamp(),clock_timestamp(),true
      FROM (SELECT 'https://rezics.com/id/'||gen_random_uuid() AS id FROM generate_series(1,$3::integer)) refs`,
    [epoch, b, size - previous]);
    await access.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
      SELECT data_epoch,'reply',reply FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2
      ON CONFLICT DO NOTHING`, [epoch, b]);
    await access.query(`INSERT INTO access.feed_item
      (data_epoch,id,sequence,kind,occurred_at,time_basis,best_key,realm,group_bucket,group_key,
        group_leader,group_members,sort_time)
      SELECT data_epoch,placement,4,'reply',occurred_at,'relay',0,realm,placement,placement,true,
        ARRAY[placement],occurred_at FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2
      ON CONFLICT DO NOTHING`, [epoch, b]);
    await access.query('ANALYZE access.realm_thread_reference');
    await access.query('ANALYZE access.realm_thread_dirty');
    await access.query('ANALYZE access.feed_item');
    let statements = 0;
    const client = await access.connect();
    try {
      const log = (await client.query<{ path: string }>("SELECT pg_current_logfile('jsonlog') AS path")).rows[0]!.path;
      const path = join(cluster!.dataDirectory, log);
      await client.query(`LOAD 'auto_explain'; SET auto_explain.log_min_duration=0;
        SET auto_explain.log_nested_statements=true; SET auto_explain.log_analyze=true;
        SET auto_explain.log_format=json; SET auto_explain.log_timing=false`);
      const offset = readFileSync(path, 'utf8').length;
      const observed = { query: async (sql: string, values: unknown[]) => {
        statements++;
        return client.query(sql, values);
      } } as unknown as Pool;
      const reading = reader('8', '4');
      const page = await realmRankPage(observed, reading.session, a, 'top', 'all', 20);
      expect(page.rows.map(row => row.reply)).toEqual([item.reply]);
      expect((await realmRankPage(observed, reading.session, empty, 'top', 'all', 20)).rows).toEqual([]);
      const plans = await loggedPlans(path, offset, 2);
      expect(plans.some(plan => plan['Query Text'].includes('WITH fence AS MATERIALIZED'))).toBe(true);
      expect(plans.some(plan => plan['Query Text'].includes('SELECT reply,placement,rank_key'))).toBe(true);
      writeFileSync(join(root, '.temp', `realm-ranking-admission-plan-${size}.json`), JSON.stringify(plans, null, 2));
      costs.push({ statements, contentReads: reading.contentReads(),
        visited: plans.reduce((count, plan) => count + visited(plan.Plan), 0) });
      await client.query('SET auto_explain.log_min_duration=-1');
      expect((await client.query<{ scan: string }>("SELECT current_setting('enable_seqscan') AS scan")).rows[0]!.scan)
        .toBe('on');
    } finally { client.release(); }
    previous = size;
  }
  expect(costs.map(cost => cost.statements)).toEqual([2, 2, 2]);
  expect(costs.map(cost => cost.contentReads)).toEqual([2, 2, 2]);
  // Count actual SQL work, including rejected rows, rather than output alone.
  expect(Math.max(...costs.map(cost => cost.visited)), JSON.stringify(costs)).toBeLessThan(100);
  expect(Math.max(...costs.map(cost => cost.visited)) - Math.min(...costs.map(cost => cost.visited)))
    .toBeLessThanOrEqual(10);
});


test('deferred thread removals do not hold another bounded page but close their selected page', async () => {
  const realm = native(), root = await reference(realm);
  const first = await reference(realm, root.reply, root.work);
  const deferred = await reference(realm, root.reply, root.work);
  const { session } = reader();
  await dirty('reply', deferred.reply);
  await expect(session.deps.realmReplyThreads.assertThreadProjection(session, realm, root.reply, undefined,
    [root.reply, first.reply])).resolves.toBeUndefined();
  await expect(session.deps.realmReplyThreads.assertThreadProjection(session, realm, root.reply, undefined,
    [root.reply, deferred.reply])).rejects.toBeInstanceOf(WorkReadUnavailable);
  await access.query('DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1', [epoch]);
  for (const [kind, resource] of [['parent', root.reply], ['work', root.work],
    ['placement', `${realm}|${root.reply}|review`]] as const) {
    await dirty(kind, resource);
    await expect(session.deps.realmReplyThreads.assertThreadProjection(session, realm, first.reply))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
    await access.query('DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1', [epoch]);
  }
});


test('thread cut visits exact selected keys as the same thread grows beyond the reply budget', async () => {
  const realm = native(), root = await reference(realm);
  const selected = await reference(realm, root.reply, root.work);
  const functionBody = (await access.query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc
    WHERE oid='access.read_realm_thread_scope_cut(text,text,text[],uuid,bigint,numeric,text)'::regprocedure`))
    .rows[0]!.prosrc;
  const parameters = ['_epoch', '_realm', '_replies', '_content_epoch', '_content_sequence', '_main_sequence', '_population'];
  const types = ['text', 'text', 'text[]', 'uuid', 'bigint', 'numeric', 'text'];
  const sql = parameters.reduce((sql, parameter, index) => sql.replaceAll(
    new RegExp(`\\b${parameter}\\b`, 'g'), `$${index + 1}::${types[index]}`), functionBody);
  interface Plan { 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number;
    'Rows Removed by Filter'?: number; Plans?: Plan[] }
  const scans = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(scans)];
  for (const size of [0, 2000]) {
    if (size) await access.query(`INSERT INTO access.realm_thread_reference
      (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,active)
      SELECT $1,$2,id,id,$3,$3,$4,clock_timestamp(),clock_timestamp(),true
      FROM (SELECT 'https://rezics.com/id/'||gen_random_uuid() AS id FROM generate_series(1,$5::integer)) refs`,
    [epoch, realm, root.reply, root.work, size]);
    await access.query('ANALYZE access.realm_thread_reference');
    const client = await access.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan=off');
      await client.query('SET LOCAL enable_bitmapscan=off');
      // Explain the installed function body: EXPLAIN of a function call hides
      // its internal scans and would miss the original whole-thread walk.
      const explained = (await client.query(`EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) ${sql}`,
        [epoch, realm, [root.reply, selected.reply], contentEpoch, '7', '3', null]))
        .rows[0]['QUERY PLAN'][0].Plan as Plan;
      const references = scans(explained).filter(plan => plan['Relation Name'] === 'realm_thread_reference');
      expect(references.length).toBeGreaterThan(0);
      expect(references.reduce((sum, plan) => sum + (plan['Actual Rows']
        + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops'], 0)).toBeLessThanOrEqual(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
});
