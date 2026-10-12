import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { RealmRankingsIncomplete, realmRankPage } from '../src/modules/rankings/realm-threads.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import type { RealmReplyContentStore } from '../src/modules/realm-reply/content-store.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

const root = resolve(import.meta.dir, '../../..');
const epoch = randomUUID();
const contentEpoch = randomUUID();
const native = () => `https://rezics.com/id/${randomUUID()}`;
let cluster: PostgresCluster | undefined;
let access: Pool;

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
}, 120_000);

afterAll(async () => {
  await access?.end();
  cluster?.remove();
});

beforeEach(async () => {
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

async function dirty(kind: 'realm' | 'reply' | 'parent' | 'work', resource: string) {
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

test('uninitialized and reset placements never masquerade as a complete empty population', async () => {
  const realm = native();
  await pending(realm);
  await expect(realmRankPage(access, reader().session, realm, 'top', 'all', 20))
    .rejects.toBeInstanceOf(RealmRankingsIncomplete);
  const existing = await reference(native());
  const indexedRealm = (await access.query<{ realm: string }>(
    'SELECT realm FROM access.realm_thread_reference WHERE reply=$1', [existing.reply])).rows[0]!.realm;
  await pending(indexedRealm, existing.placement);
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
  await reference(a);
  await pending(b);
  const { session } = reader('8', '4');
  // The writer-owned thread gate is part of the same acceptance rule.
  await expect(session.deps.realmReplyThreads!.assertThreadProjection(session)).resolves.toBeUndefined();
});

for (const aggregate of [false, true]) {
  test(`acknowledged ${aggregate ? 'child' : 'root'} review removal fences A before replay and leaves B open`, async () => {
    const a = native(), b = native();
    const item = await reference(a), other = await reference(b);
    const removed = aggregate ? await reference(a, item.reply, item.work) : item;
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
    Object.assign(registry, {
      register: async () => admission, claim: async () => admission,
      recordGraphOutcome: async () => undefined,
    });
    let terminal = false, revoked = false;
    const content = {
      hasReceipt: async () => false,
      decideReview: async () => {
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
    await new RealmReplyStore(content, {} as ConstructorParameters<typeof RealmReplyStore>[1], registry, env)
      .review({ issuer: 'https://account.test', subject: admission.principalId }, admission.actingSubject, {
        realm: a, reply: removed.reply, revisionId: randomUUID(), revisionDigest: 'b'.repeat(64),
        expectedGeneration: '1', supersedes: randomUUID(), outcome: 'revoked', method: 'human',
        methodRevision: 'human-review-v1', dependencyDigest: 'c'.repeat(64), reasonReference: 'withdrawn',
      }, admission.idempotencyKey, admission.requestDigest);
    expect(revoked).toBe(true);
    const unaffected = await realmRankPage(access, reader('8', '4').session, b, 'top', 'all', 20);
    expect(unaffected.rows.map(row => row.reply)).toEqual([other.reply]);
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
    if (plans.filter(plan => plan['Query Text'].includes('SELECT * FROM access.read_realm_thread_rank_cut')).length === pages)
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
