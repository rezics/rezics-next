import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ensureFixtureScopeGate, grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { refreshReadRankingAdmissions } from '../../../services/main/src/modules/feed/ranking-admission.ts';
import { ReadRankingProjection, RankingProjectionUnavailable, rankingBuckets } from '../../../services/main/src/modules/rankings/projection.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { assertWorkCostAtScales, type WorkProfile } from '../support/work-profile.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const route = '/v1/rankings/trending?metric=reads&interval=day&limit=1';
type Page = { items: Array<{ id: string; score: number }>; nextCursor: string | null;
  count: { value: number; kind: string; total: null } };
type Statement = { sql: string; values: unknown[] };
type Plan = { 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: Plan[] };
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

async function waitsOnAdvisory(pool: Pool, pid: number) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: boolean }>(`SELECT wait_event_type='Lock'
      AND lower(wait_event)='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1`, [pid]);
    if (waiting.rows[0]?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error('Concurrent ranking publisher did not wait for its Work owner');
}

function observe(pool: Pool) {
  const statements: Statement[] = [];
  const query = async (connection: Pool | PoolClient, sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    return connection.query(sql, values);
  };
  const observed = new Proxy(pool, { get(target, property) {
    if (property === 'query') return (sql: string, values?: unknown[]) => query(target, sql, values);
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, member) {
        if (member === 'query') return (sql: string, values?: unknown[]) => query(connection, sql, values);
        const value = Reflect.get(connection, member);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { pool: observed, statements };
}

async function fixture() {
  const run = Bun.env.REZICS_QA_RUN_ID;
  if (!run) throw new Error('Run ranking population checks through goalctl test');
  const owners = await cloneQaOwnerDatabases(run, ['access', 'content', 'relay'], 'privileged');
  let stack: MediaStack | undefined;
  try {
    stack = await startMediaStack('ranking-population-cut', { ownerUrls: owners.urls });
    const member = await stack.member('population-reader');
    const first = await stack.publicWork(member.actor, ['en'], 'First ranked Work');
    const second = await stack.publicWork(member.actor, ['en'], 'Second ranked Work');
    const meter = observe(stack.accessPool);
    const projection = new ReadRankingProjection(meter.pool, stack.content, stack.contentPool, stack.env);
    const progress = new StructureProgressStore(stack.contentPool);
    for (const work of [first.work, second.work]) {
      await progress.write({ principal: member.principal, structure: work, occurrence: work,
        selectedRevision: null, completed: false, position: null, expectedVersion: 0,
        idempotencyKey: randomUUID() });
      await stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),1)', [work]);
    }
    for (let tick = 0; tick < 100 && await projection.tick(); tick++) { /* bounded owner replay */ }
    const checkpoint = await projection.current();
    const bucket = rankingBuckets(new Date(), 'day').current;
    await stack.accessPool.query(`UPDATE access.read_ranking_score SET score=9,growth=9
      WHERE generation=$1 AND work=$2 AND metric='reads' AND interval='day' AND bucket=$3`,
    [checkpoint.generation, first.work, bucket]);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      readRankings: projection, media: stack.media, mediaAccess: stack.mediaAccess });
    let pendingCount = 0;
    return { stack, projection, checkpoint, bucket, first, second, meter, member,
      async pendingAdditions(count: number) {
        const start = await stack!.content.ownerPosition();
        for (; pendingCount < count; pendingCount++) {
          const work = native();
          await progress.write({ principal: member.principal, structure: work, occurrence: work,
            selectedRevision: null, completed: false, position: null, expectedVersion: 0,
            idempotencyKey: randomUUID() });
        }
        let sequence = start.sequence;
        const owner = await stack!.content.ownerPosition();
        while (BigInt(sequence) < BigInt(owner.sequence)) {
          const events = await stack!.content.readOutbox(owner.dataEpoch, sequence, 100);
          if (!events.length) throw new Error('Pending addition fixture lost owner event custody');
          await stack!.accessPool.query(`INSERT INTO access.read_ranking_pending
            (generation,source,position,target,source_event)
            SELECT $1,'content',position,target,event FROM jsonb_to_recordset($2::jsonb)
              AS retained(position bigint,target text,event jsonb)`,
          [checkpoint.generation, JSON.stringify(events.filter(event => event.recipe === 'structure-progress-v1')
            .map(event => ({ position: event.position.sequence, target: event.payload.structure, event })))]);
          sequence = events.at(-1)!.position.sequence;
        }
        await stack!.accessPool.query(`UPDATE access.read_ranking_checkpoint
          SET content_scan_sequence=$1,updated_at=clock_timestamp()-interval '2 minutes' WHERE singleton`,
        [owner.sequence]);
      },
      async request(path = route) {
        const response = await app.handle(new Request(`http://main.local${path}`));
        return { status: response.status, body: await response.json() as Page & { code?: string } };
      },
      async close() { await stack!.stop(); await owners.close(); } };
  } catch (error) { await stack?.stop(); await owners.close(); throw error; }
}

/** Pause after the production statement has copied both revision and rows. */
async function afterCapture<T>(projection: ReadRankingProjection, change: () => Promise<void>,
  operation: () => Promise<T>) {
  const capture = projection.capture.bind(projection);
  let changed = false;
  projection.capture = async (...args) => {
    const cut = await capture(...args);
    if (!changed) { changed = true; await change(); }
    return cut;
  };
  try { const result = await operation(); expect(changed).toBe(true); return result; }
  finally { projection.capture = capture; }
}

async function pendingAddition(f: Awaited<ReturnType<typeof fixture>>) {
  await f.pendingAdditions(1);
}

test('ranking population capture survives unrelated context, metric, bucket, graph writes and failed additions', async () => {
  const f = await fixture();
  try {
    const result = await afterCapture(f.projection, async () => {
      await pendingAddition(f);
      await f.stack.accessPool.query(`INSERT INTO access.read_ranking_admitted
        (generation,metric,interval,bucket,context,work,score,growth) VALUES
        ($1,'reads','day',$2,$3,$4,200,200),
        ($1,'reviews','day',$2,'urn:rezics:context:global',$4,200,200),
        ($1,'reads','day',$5,'urn:rezics:context:global',$4,200,200)`,
      [f.checkpoint.generation, f.bucket, native(), native(), rankingBuckets(new Date(), 'day').previous]);
      await f.stack.accessPool.query(`INSERT INTO access.read_ranking_score
        (generation,metric,interval,bucket,work,score,growth) VALUES
        ($1,'finished-chapters','day',$2,$3,2,2),($1,'reads','day',$4,$3,2,2)`,
      [f.checkpoint.generation, f.bucket, f.first.work, rankingBuckets(new Date(), 'day').previous]);
      await f.stack.catalogueWork(native(), 'Unrelated graph addition');
    }, () => f.request());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ items: [{ id: f.first.work, score: 9 }],
      count: { value: 1, kind: 'exact-page', total: null } });
    expect(result.body.nextCursor).toBeString();
    const next = await f.request(`${route}&cursor=${encodeURIComponent(result.body.nextCursor!)}`);
    expect(next.status).toBe(200);
    expect(next.body.items.map(item => item.id)).toEqual([f.second.work]);
  } finally { await f.close(); }
}, 180_000);

test('ranking continuation expires only when its own published population revision changes', async () => {
  const f = await fixture();
  try {
    const first = await f.request();
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeString();
    await f.stack.accessPool.query(`UPDATE access.read_ranking_score SET score=score+1,growth=growth+1
      WHERE generation=$1 AND work=$2 AND metric='reads' AND interval='day' AND bucket=$3`,
    [f.checkpoint.generation, f.second.work, f.bucket]);
    const next = await f.request(`${route}&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    expect(next.status).toBe(409);
    const refreshed = await f.request();
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.nextCursor).toBeString();
    await f.stack.accessPool.query('UPDATE access.read_ranking_checkpoint SET generation=$1 WHERE singleton', [randomUUID()]);
    const replacement = await f.request(`${route}&cursor=${encodeURIComponent(refreshed.body.nextCursor!)}`);
    expect(replacement.status).toBe(409);
  } finally { await f.close(); }
}, 180_000);

test('a selected Work scope removal after population capture is absent from delivery and its page count', async () => {
  const f = await fixture();
  try {
    const scope = `work:read:${f.first.work}`;
    await ensureFixtureScopeGate(f.stack.accessPool, scope);
    const epoch = (await f.stack.accessPool.query<{ authority_epoch: string }>(
      'SELECT authority_epoch::text FROM access.scope_gate WHERE id=$1', [scope])).rows[0]!.authority_epoch;
    const response = await afterCapture(f.projection, async () => {
      await f.stack.access.closeScope(scope, epoch);
    }, () => f.request());
    expect(response.status).toBe(200);
    expect(response.body.items.some(item => item.id === f.first.work)).toBe(false);
    expect(response.body.count).toEqual({ value: response.body.items.length, kind: 'exact-page', total: null });
    const current = await f.request();
    expect(current.status).toBe(200);
    expect(current.body.items.map(item => item.id)).toEqual([f.second.work]);
  } finally { await f.close(); }
}, 180_000);

test('a review removal after capture makes only its affected ranking population incomplete and recovers after replay', async () => {
  const f = await fixture();
  try {
    await grantFixtureAuthority(f.stack.accessPool, { scope: 'space:create:root', requireDispatch: true,
      representations: [{ principalId: f.member.principalId, actor: f.member.actor,
        action: 'space.create', lifetime: '8 hours' }],
      grant: { actor: f.member.actor, action: 'space.create', lifetime: '8 hours' } });
    const created = await f.member.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
      name: 'Unrelated ranking Realm', capabilities: ['realm'], actingSubject: f.member.actor });
    expect(created.status).toBe(201);
    const realm = (await created.json() as { realm: string }).realm;
    const reviews = route.replace('metric=reads', 'metric=reviews');
    const removed = await afterCapture(f.projection, async () => {
      await f.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),-1)',
        [f.first.work]);
    }, () => f.request(reviews));
    expect(removed.status).toBe(503);
    expect(removed.body).toMatchObject({ code: 'rankings_incomplete' });
    const source = f.stack.env.fuseki.query.bind(f.stack.env.fuseki);
    f.stack.env.fuseki.query = async (...args) => {
      if (args[0].includes('SELECT DISTINCT ?work ?main ?head ?realm') && args[0].includes(f.first.work))
        throw new Error('Review target graph unavailable during negative replay');
      return source(...args);
    };
    try { await f.projection.tick(); }
    finally { f.stack.env.fuseki.query = source; }
    expect((await f.stack.accessPool.query(`SELECT target FROM access.read_ranking_pending
      WHERE generation=$1 AND source='review' AND target=$2`, [f.checkpoint.generation, f.first.work])).rows)
      .toEqual([{ target: f.first.work }]);
    expect((await f.request(reviews)).status).toBe(503);
    expect((await f.request()).status).toBe(200);
    const unrelated = await f.request(`/v1/realms/${realm.slice(-36)}/rankings?metric=reviews&interval=day`);
    expect(unrelated.status).toBe(200);
    expect(unrelated.body.items).toEqual([]);
    const previous = rankingBuckets(new Date(), 'day').previous;
    expect((await f.projection.capture('reviews', 'day', previous, 'score', null, 2)).rows).toEqual([]);
    const retained = (await f.stack.accessPool.query<{ position: string; source_event: object }>(
      `SELECT position::text,source_event FROM access.read_ranking_pending
       WHERE generation=$1 AND source='review' AND target=$2`, [f.checkpoint.generation, f.first.work])).rows[0]!;
    await f.stack.accessPool.query(`UPDATE access.read_ranking_pending
      SET source_event=jsonb_set(source_event,'{work}',to_jsonb($3::text))
      WHERE generation=$1 AND source='review' AND position=$2`,
    [f.checkpoint.generation, retained.position, f.second.work]);
    try {
      await expect(f.projection.tick()).rejects.toBeInstanceOf(RankingProjectionUnavailable);
      expect((await f.request(reviews)).status).toBe(503);
      expect((await f.stack.accessPool.query(`SELECT work FROM access.read_ranking_removal
        WHERE work=$1`, [f.first.work])).rows).toHaveLength(6);
      expect((await f.stack.accessPool.query(`SELECT score::text FROM access.read_ranking_score
        WHERE generation=$1 AND work=$2 AND metric='reviews' AND interval='day' AND bucket=$3`,
      [f.checkpoint.generation, f.second.work, f.bucket])).rows).toEqual([{ score: '1' }]);
    } finally {
      await f.stack.accessPool.query(`UPDATE access.read_ranking_pending SET source_event=$3::jsonb
        WHERE generation=$1 AND source='review' AND position=$2`,
      [f.checkpoint.generation, retained.position, JSON.stringify(retained.source_event)]);
    }
    for (let tick = 0; tick < 100 && await f.projection.tick(); tick++) { /* removal replay */ }
    const recovered = await f.request(reviews);
    expect(recovered.status).toBe(200);
    expect(recovered.body.items.map(item => item.id)).toEqual([f.second.work]);
  } finally { await f.close(); }
}, 180_000);

test('ranking SQL statements and actual executor rows stay constant across three unrelated inventories', async () => {
  const f = await fixture();
  const evidence: Array<{ inventory: number; pending: number; sql: number; executorRows: number }> = [];
  const profiles: WorkProfile[] = [];
  try {
    // Measure the indexed path at meaningful inventories. Tiny tables can
    // legitimately use cheaper sequential scans; never force planner settings.
    for (const [inventory,pending] of [[1024,64],[8192,512],[65536,4096]] as const) {
      await f.stack.accessPool.query(`DELETE FROM access.read_ranking_admitted
        WHERE generation=$1 AND context LIKE 'urn:rezics:context:unrelated:%'`, [f.checkpoint.generation]);
      await f.stack.accessPool.query(`INSERT INTO access.read_ranking_admitted
        (generation,metric,interval,bucket,context,work,score,growth)
        SELECT $1,'reads','day',$2,'urn:rezics:context:unrelated:'||n,
          'https://rezics.com/id/'||md5($3||n::text)::uuid::text,100,100
        FROM generate_series(1,$4::integer) n`, [f.checkpoint.generation, f.bucket, randomUUID(), inventory]);
      await f.pendingAdditions(pending);
      await f.stack.accessPool.query(`SELECT access.append_reader_review_rank_change(
        'https://rezics.com/id/'||md5($1||n::text)::uuid::text,'2020-01-01'::timestamptz,-1)
        FROM generate_series(1,$2::integer) n`, [randomUUID(), pending]);
      await f.stack.accessPool.query('ANALYZE access.read_ranking_admitted');
      await f.stack.accessPool.query('ANALYZE access.read_ranking_pending');
      await f.stack.accessPool.query('ANALYZE access.read_ranking_removal');
      await f.stack.accessPool.query('ANALYZE access.read_ranking_publication');
      f.meter.statements.length = 0;
      const response = await f.request();
      expect(response.status).toBe(200);
      expect(response.body.items.map(item => item.id)).toEqual([f.first.work]);
      const statements = [...f.meter.statements];
      let executorRows = 0;
      for (const statement of statements.filter(row => /\b(?:SELECT|WITH)\b/iu.test(row.sql))) {
        const explained = await f.stack.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${statement.sql}`, statement.values);
        const scans = nodes(explained.rows[0]!['QUERY PLAN'][0]!.Plan).filter(node => node['Relation Name']);
        executorRows += scans.reduce((sum, node) => sum + (node['Actual Rows']
          + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0))
          * node['Actual Loops'], 0);
      }
      evidence.push({ inventory,pending,sql: statements.length,executorRows });
      // Only projection-owner SQL is observed here; all other work remains unknown.
      profiles.push({ traceId: '', request: { service: 'main', route, status: response.status },
        postgresStatements: statements.length, mainCalls: null, fusekiRequests: null,
        fusekiSentBytes: null, fusekiReceivedBytes: null, fusekiEngineMs: null,
        accountCalls: null, otherFetches: null, unclassifiedFetches: 0,
        serverLatencyMs: 0, totalLatencyMs: 0, fusekiCalls: [], postgres: [], unobserved: [], spans: [] });
    }
    console.info(JSON.stringify({ capability: 'ranking-population-cut', evidence }));
    assertWorkCostAtScales(profiles, { postgresStatements: 4 }, 'ranking-population-cut-sql');
    expect(new Set(evidence.map(row => row.sql)).size).toBe(1);
    expect(new Set(evidence.map(row => row.executorRows)).size).toBe(1);
    expect(evidence.every(row => row.executorRows > 0 && row.executorRows <= 32)).toBe(true);
  } finally { await f.close(); }
}, 180_000);

test('a failed addition and removal outside the admitted population do not close its Review page', async () => {
  const f = await fixture();
  const query = f.stack.env.fuseki.query.bind(f.stack.env.fuseki);
  try {
    const author = await f.stack.member('unranked-review-author');
    const outsider = await f.stack.publicWork(author.actor, ['en'], 'Unprojected Review Work');
    f.stack.env.fuseki.query = async (...args) => {
      if (args[0].includes('SELECT DISTINCT ?work ?main ?head ?realm') && args[0].includes(outsider.work)) {
        throw new Error('Unranked Review target is unavailable');
      }
      return query(...args);
    };
    await f.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),1)', [outsider.work]);
    await f.projection.tick();
    const reviews = route.replace('metric=reads','metric=reviews');
    const page = await afterCapture(f.projection, async () => {
      await f.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),-1)', [outsider.work]);
      await f.projection.tick();
    }, () => f.request(reviews));
    expect(page.status).toBe(200);
    expect(page.body.items.every(item => item.id !== outsider.work)).toBe(true);
    expect((await f.stack.accessPool.query(`SELECT position FROM access.read_ranking_pending
      WHERE generation=$1 AND source='review' AND target=$2`, [f.checkpoint.generation,outsider.work])).rows).toHaveLength(2);
    expect((await f.request(reviews)).status).toBe(200);
  } finally { f.stack.env.fuseki.query = query; await f.close(); }
}, 180_000);

test('a review removal replayed completely after capture still withholds the earlier score', async () => {
  const f = await fixture();
  try {
    await f.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),1)',
      [f.first.work]);
    for (let tick = 0; tick < 100 && await f.projection.tick(); tick++) { /* establish two reviews */ }
    const reviews = route.replace('metric=reads', 'metric=reviews');
    const removed = await afterCapture(f.projection, async () => {
      await f.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),-1)',
        [f.first.work]);
      for (let tick = 0; tick < 100 && await f.projection.tick(); tick++) { /* remove before delivery */ }
      expect((await f.stack.accessPool.query('SELECT event_id FROM access.read_ranking_removal WHERE work=$1',
        [f.first.work])).rows).toEqual([]);
      expect((await f.stack.accessPool.query(`SELECT score::text FROM access.read_ranking_admitted
        WHERE generation=$1 AND work=$2 AND context='urn:rezics:context:global'
          AND metric='reviews' AND interval='day' AND bucket=$3`,
      [f.checkpoint.generation, f.first.work, f.bucket])).rows).toEqual([{ score: '1' }]);
    }, () => f.request(reviews));
    expect(removed.status).toBe(503);
    expect(removed.body).toMatchObject({ code: 'rankings_incomplete' });
    const current = await f.request(reviews);
    expect(current.status).toBe(200);
    expect(current.body.items.every(item => item.score === 1)).toBe(true);
  } finally { await f.close(); }
}, 180_000);

test('an acknowledged Review removal binds to scores materialized while its source transaction holds the Work owner', async () => {
  const f = await fixture();
  const source = await f.stack.accessPool.connect();
  const publisher = await f.stack.accessPool.connect();
  let publication: Promise<unknown> | undefined;
  try {
    const outsider = await f.stack.publicWork(f.member.actor, ['en'], 'Concurrent Review Work');
    await refreshReadRankingAdmissions(f.stack.env, f.stack.accessPool, [outsider.work]);
    await f.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),1)',
      [outsider.work]);
    await f.stack.accessPool.query('SELECT access.sequence_reader_review_ranks(100)');
    const positive = (await f.stack.accessPool.query<{ position: string | null; occurred_at: Date }>(
      `SELECT position::text,occurred_at FROM access.reader_review_rank_change
       WHERE work=$1 AND delta=1 ORDER BY id DESC LIMIT 1`, [outsider.work])).rows[0]!;
    expect(positive.position).not.toBeNull();
    expect(BigInt(positive.position!)).toBe(BigInt(f.checkpoint.reviewPosition) + 1n);
    expect((await f.stack.accessPool.query('SELECT work FROM access.read_ranking_score WHERE work=$1',
      [outsider.work])).rows).toEqual([]);

    await source.query('BEGIN');
    await source.query('SELECT access.append_reader_review_rank_change($1,$2,-1)',
      [outsider.work, positive.occurred_at]);
    const pending = await source.query<{ generation: string | null }>(
      'SELECT generation::text FROM access.read_ranking_removal WHERE work=$1', [outsider.work]);
    expect(pending.rows).toHaveLength(6);
    expect(pending.rows.every(row => row.generation === null)).toBe(true);

    await publisher.query('BEGIN');
    await publisher.query("SET LOCAL lock_timeout='5s'");
    const pid = (await publisher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    publication = publisher.query(`INSERT INTO access.read_ranking_score
      (generation,metric,interval,bucket,work,score,growth)
      SELECT $1,'reviews',period.interval,date_trunc(period.interval,$2::timestamptz AT TIME ZONE 'UTC')::date,
        $3,1,1 FROM (VALUES ('day'),('week'),('month')) period(interval)`,
    [f.checkpoint.generation, positive.occurred_at, outsider.work]);
    // Install a rejection handler immediately; the observed query is awaited below.
    void publication.catch(() => {});
    await waitsOnAdvisory(f.stack.accessPool, pid);
    await source.query('COMMIT');
    await publication;
    // This transaction materialized the acknowledged positive event, so its
    // checkpoint must advance with all three score intervals before replay resumes.
    await publisher.query(`UPDATE access.read_ranking_checkpoint SET
      review_scan_position=$1,review_position=$1,updated_at=clock_timestamp() WHERE singleton`,
    [positive.position]);
    await publisher.query('COMMIT');

    const bound = await f.stack.accessPool.query<{ generation: string; interval: string }>(
      `SELECT generation::text,interval FROM access.read_ranking_removal
       WHERE work=$1 AND generation IS NOT NULL ORDER BY interval`, [outsider.work]);
    expect(bound.rows).toEqual(['day', 'month', 'week'].map(interval => ({ generation: f.checkpoint.generation, interval })));
    // A retained old generation cannot steal an active removal's applicability.
    await f.stack.accessPool.query(`INSERT INTO access.read_ranking_score
      (generation,metric,interval,bucket,work,score,growth)
      VALUES ($1,'reviews','day',$2,$3,1,1)`, [randomUUID(), f.bucket, outsider.work]);
    expect((await f.stack.accessPool.query(`SELECT DISTINCT generation::text FROM access.read_ranking_removal
      WHERE work=$1 AND generation IS NOT NULL`, [outsider.work])).rows)
      .toEqual([{ generation: f.checkpoint.generation }]);
    expect((await f.stack.accessPool.query<{ removed: boolean }>(`SELECT removal_revision>0 AS removed
      FROM access.read_ranking_publication WHERE generation=$1 AND context='urn:rezics:context:global'
        AND metric='reviews' AND interval='day' AND bucket=$2`, [f.checkpoint.generation, f.bucket])).rows)
      .toEqual([{ removed: true }]);
    const reviews = route.replace('metric=reads', 'metric=reviews');
    const incomplete = await f.request(reviews);
    expect(incomplete.status).toBe(503);
    expect(incomplete.body).toMatchObject({ code: 'rankings_incomplete' });
    expect((await f.request()).status).toBe(200);

    for (let tick = 0; tick < 100 && await f.projection.tick(); tick++) { /* apply only the negative owner event */ }
    const recovered = await f.request(reviews);
    expect(recovered.status).toBe(200);
    expect(recovered.body.items.every(item => item.id !== outsider.work)).toBe(true);
    expect((await f.stack.accessPool.query('SELECT work FROM access.read_ranking_score WHERE work=$1',
      [outsider.work])).rows).toEqual([]);
    expect((await f.stack.accessPool.query('SELECT work FROM access.read_ranking_removal WHERE work=$1',
      [outsider.work])).rows).toEqual([]);
  } finally {
    await source.query('ROLLBACK');
    await publication?.catch(() => {});
    await publisher.query('ROLLBACK');
    source.release();
    publisher.release();
    await f.close();
  }
}, 180_000);

test('two cached retained Review retries cannot replay or retain a negative event after its first worker settles', async () => {
  const f = await fixture();
  const source = f.stack.env.fuseki.query.bind(f.stack.env.fuseki);
  const holder = await f.stack.accessPool.connect();
  let turns: Array<Promise<number>> = [];
  try {
    await f.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1,clock_timestamp(),-1)',
      [f.first.work]);
    f.stack.env.fuseki.query = async (...args) => {
      if (args[0].includes('SELECT DISTINCT ?work ?main ?head ?realm') && args[0].includes(f.first.work))
        throw new Error('Review admission unavailable before concurrent retry');
      return source(...args);
    };
    try { await f.projection.tick(); }
    finally { f.stack.env.fuseki.query = source; }
    expect((await f.stack.accessPool.query(`SELECT target FROM access.read_ranking_pending
      WHERE generation=$1 AND source='review' AND target=$2`, [f.checkpoint.generation, f.first.work])).rows)
      .toEqual([{ target: f.first.work }]);

    await holder.query('BEGIN');
    await holder.query('SELECT access.lock_read_ranking_works($1::text[])', [[f.first.work]]);
    const workers = [0, 1].map(() => new ReadRankingProjection(f.stack.accessPool, f.stack.content,
      f.stack.contentPool, f.stack.env));
    turns = workers.map(worker => worker.tick());
    for (const turn of turns) void turn.catch(() => {});
    const deadline = Date.now() + 2_500;
    let waiting = false;
    while (Date.now() < deadline) {
      const blocked = await f.stack.accessPool.query<{ count: number }>(`SELECT count(*)::integer AS count
        FROM pg_stat_activity WHERE datname=current_database() AND state='active'
          AND wait_event_type='Lock' AND lower(wait_event)='advisory'
          AND query LIKE 'SELECT access.lock_read_ranking_works%'`);
      if (blocked.rows[0]!.count === 2) { waiting = true; break; }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    await holder.query('COMMIT');
    await Promise.all(turns);

    expect((await f.stack.accessPool.query(`SELECT work FROM access.read_ranking_score
      WHERE generation=$1 AND metric='reviews' AND work=$2`, [f.checkpoint.generation, f.first.work])).rows)
      .toEqual([]);
    expect((await f.stack.accessPool.query(`SELECT target FROM access.read_ranking_pending
      WHERE generation=$1 AND source='review' AND target=$2`, [f.checkpoint.generation, f.first.work])).rows)
      .toEqual([]);
    expect((await f.stack.accessPool.query('SELECT work FROM access.read_ranking_removal WHERE work=$1',
      [f.first.work])).rows).toEqual([]);
    const reviews = await f.request(route.replace('metric=reads', 'metric=reviews'));
    expect(reviews.status).toBe(200);
    expect(reviews.body.items.map(item => item.id)).toEqual([f.second.work]);
    expect(await f.projection.tick()).toBe(0);
  } finally {
    f.stack.env.fuseki.query = source;
    await holder.query('ROLLBACK');
    await Promise.allSettled(turns);
    holder.release();
    await f.close();
  }
}, 180_000);
