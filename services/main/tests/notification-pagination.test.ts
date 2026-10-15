import { afterAll, beforeAll, expect, test } from 'bun:test';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { NotificationDenied, NotificationInvalid, NotificationStale, NotificationStore }
  from '../src/modules/notification/store.ts';
import { notificationRoutes } from '../src/routes/notifications.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AgentProvisioning, agentProvisionDigest } from '../src/modules/agent/provision.ts';
import { EditorialReviewStore, type EditorialCall } from '../src/modules/editorial-review/store.ts';
import type { EditorialAdapter, EditorialTarget } from '../src/modules/editorial-review/contract.ts';

const root = resolve(import.meta.dir, '../../..');
let cluster: PostgresCluster | undefined;
let pool: Pool;
type Selection = { view?: 'inbox' | 'saved' | 'done'; reason?: 'manual' | 'reviewer' };
const selections: Selection[] = [{ view: 'saved' }, { view: 'done' }, { reason: 'reviewer' },
  { view: 'saved', reason: 'manual' }, { view: 'done', reason: 'manual' }];
type Statement = { sql: string; args: unknown[] };
type FixtureRow = { id: string; sequence: string; saved: boolean; done: boolean; reason: string };
let backfill: Awaited<ReturnType<typeof seedOwner>> & { itemId: string };

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4, connectionTimeoutMillis: 1000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      if (file.endsWith('_notification_filter_seek.sql')) {
        // Owning operations need the earlier schemas visible to their own transactions.
        await client.query('COMMIT');
        const owner = await seedOwner(), itemId = randomUUID();
        await client.query('BEGIN');
        await client.query("UPDATE access.notification_stream SET head_sequence = 1 WHERE principal_id = $1", [owner.id]);
        await client.query(`INSERT INTO access.notification_item (id,principal_id,stream,generation,sequence,
          purpose,topic,source_owner,source_event,subject_owner,subject_ref,disclosure_basis)
          VALUES ($1::uuid,$2,'inbox',1,1,'governance','proposal-revised','access',$1::text,'access','fixture','proposal')`,
        [itemId, owner.id]);
        await client.query(`INSERT INTO access.notification_item_triage (principal_id,item_id,saved,done)
          VALUES ($1,$2,true,true)`, [owner.id, itemId]);
        await client.query(`INSERT INTO access.notification_proposal_context (item_id,proposal,revision,reason)
          VALUES ($1,$2,1,'manual')`, [itemId, owner.proposal]);
        await client.query("UPDATE access.notification_item SET state = 'erased',state_changed_at = now() WHERE id = $1", [itemId]);
        backfill = { ...owner, itemId };
      }
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}, 90_000);

afterAll(async () => { await pool?.end(); cluster?.remove(); });

/** Record the statement sent to PostgreSQL, without evaluating or replacing any SQL. */
function recordingPool(statements: Statement[], afterHead?: () => Promise<void>, afterGeneration?: () => Promise<void>) {
  let arrived = false;
  return new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, member) {
        if (member === 'query') return async (sql: string, args: unknown[] = []) => {
          const counted = foregroundCounted();
          const result = await connection.query(sql, args);
          if (counted && sql.includes('AS individually_read')) statements.push({ sql, args: [...args] });
          if (afterHead && !arrived && sql.includes('head_sequence::text FROM access.notification_stream')) {
            arrived = true;
            await afterHead();
          }
          if (afterGeneration && !arrived && sql.includes('generation::text') && sql.includes('FROM access.notification_stream')) {
            arrived = true;
            await afterGeneration();
          }
          return result;
        };
        const value = Reflect.get(connection, member);
        return typeof value === 'function' ? value.bind(connection) : value;
      } }) as PoolClient;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function seedOwner() {
  const principal = { issuer: 'https://account.rezics.test', subject: randomUUID() };
  const input = { kind: 'service' as const, displayName: 'Notification recipient' };
  const fuseki = new FusekiClient('http://notification-fixture.invalid');
  // This owner test substitutes the graph receipt boundary, while provisioning
  // retains its real principal, control, activation and receipt operations.
  const epoch = randomUUID();
  fuseki.query = async () => ({ results: { bindings: [{
    digest: { type: 'literal', value: agentProvisionDigest(input) },
    epoch: { type: 'literal', value: epoch }, sequence: { type: 'literal', value: '1' },
  }] } });
  const environment = { fuseki, objectDirectory: join(root, '.temp/notification-fixture'),
    lineage: { dataEpoch: epoch, routingEpoch: epoch } };
  const agent = await new AgentProvisioning(pool, environment).provision({ verify: async () => principal },
    new Request('http://localhost/v1/agents'), input, randomUUID());
  expect(agent.state).toBe('active');
  const id = (await pool.query<{ id: string }>(
    'SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2',
    [principal.issuer, principal.subject])).rows[0]!.id;
  await pool.query("INSERT INTO access.notification_stream (principal_id,stream) VALUES ($1,'inbox')", [id]);
  const target: EditorialTarget = { resource: `https://rezics.com/id/${randomUUID()}`,
    revision: `https://rezics.com/id/${randomUUID()}`, context: 'urn:rezics:context:global', work: null };
  const validated = { candidate: {}, before: {}, baseHeads: [{ component: target.resource, head: target.revision }] };
  const adapter = { kind: 'title', requiredApprovals: 1,
    validate: async () => validated, preview: async () => [],
    apply: async () => { throw new Error('Fixture proposal is never applied'); },
    compensate: async () => { throw new Error('Fixture proposal is never compensated'); },
  } satisfies EditorialAdapter;
  class FixtureEditorialStore extends EditorialReviewStore {
    override async resolveTarget(_call: Pick<EditorialCall, 'work' | 'request' | 'actingSubject'>,
      _resource: string, _context: EditorialTarget['context']) { return target; }
  }
  const editorial = new FixtureEditorialStore(pool, Promise.resolve(new Map([['title', { kind: 'title', create: () => adapter }]])));
  const proposal = await editorial.create({ principal, actingSubject: agent.agent,
    request: new Request('http://localhost/v1/editorial/proposals'),
    work: { environment } as unknown as MainWorkDependencies },
  { kind: 'title', target, candidate: {}, baseHeads: validated.baseHeads, evidence: [] }, randomUUID());
  expect(proposal).toMatchObject({ outcome: 'created', revision: 1 });
  return { id, proposal: proposal.proposal, principal };
}

async function inbox() {
  const { id, proposal, principal } = await seedOwner();
  const statements: Statement[] = [];
  const rows: FixtureRow[] = [];
  let generation = '1';

  async function insert(items: Omit<FixtureRow, 'id'>[], head = items.at(-1)?.sequence ?? '0',
    options: { triage: boolean; context: boolean; erase: boolean; splitTriage?: boolean }
      = { triage: true, context: true, erase: true }) {
    const client = await pool.connect();
    const data = items.map(item => ({ ...item, id: randomUUID() }));
    const triage = async () => {
      if (options.triage) await client.query(`INSERT INTO access.notification_item_triage (principal_id,item_id,saved,done)
        SELECT $1,d.id,d.saved,d.done FROM jsonb_to_recordset($2::jsonb) AS d(id uuid,saved boolean,done boolean)`,
      [id, JSON.stringify(data)]);
    };
    const erase = async () => {
      // Erased owner records need no external subject resolver; their private triage remains pageable.
      if (options.erase) await client.query(`UPDATE access.notification_item SET state = 'erased',state_changed_at = now()
        WHERE principal_id = $1 AND generation = $2 AND state = 'active'`, [id, generation]);
    };
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE access.notification_stream SET head_sequence = $2
        WHERE principal_id = $1 AND stream = 'inbox'`, [id, head]);
      await client.query(`INSERT INTO access.notification_item (id,principal_id,stream,generation,sequence,
        purpose,topic,source_owner,source_event,subject_owner,subject_ref,disclosure_basis)
        SELECT d.id,$1,'inbox',$2,d.sequence,'governance','proposal-revised','access',d.id::text,
          'access','fixture','proposal' FROM jsonb_to_recordset($3::jsonb) AS d(id uuid,sequence bigint)`,
      [id, generation, JSON.stringify(data)]);
      if (!options.splitTriage) await triage();
      if (options.context) await client.query(`INSERT INTO access.notification_proposal_context (item_id,proposal,revision,reason)
        SELECT d.id,$1,1,d.reason FROM jsonb_to_recordset($2::jsonb) AS d(id uuid,reason text)`,
      [proposal, JSON.stringify(data)]);
      if (!options.splitTriage) await erase();
      await client.query('COMMIT');
      if (options.splitTriage) {
        // A person saves or completes notifications after enqueue has committed.
        await client.query('BEGIN');
        await triage();
        await erase();
        await client.query('COMMIT');
      }
      rows.push(...data);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const sparse = () => Array.from({ length: 246 }, (_, index) => ({ sequence: String((index + 1) * 71),
    saved: index % 2 === 0, done: index % 2 === 0, reason: index % 2 === 0 ? 'manual' : 'reviewer' }));
  return { id, proposal, principal, statements, rows, insert, sparse,
    store: new NotificationStore(recordingPool(statements)),
    async reset() {
      await pool.query(`UPDATE access.notification_stream SET generation = generation + 1,
        head_sequence = 0,reset_at = now() WHERE principal_id = $1 AND stream = 'inbox'`, [id]);
      generation = String(BigInt(generation) + 1n);
      rows.length = 0;
      await insert(sparse(), '20000');
    },
    deny: () => pool.query('UPDATE access.principal SET active = false WHERE id = $1', [id]),
  };
}

function matches(row: FixtureRow, selection: Selection) {
  return (selection.view === 'saved' ? row.saved : selection.view === 'done' ? row.done : !row.done)
    && (!selection.reason || row.reason === selection.reason);
}

test('migration preserves Saved, Done and reason matches that existed before the seek indexes', async () => {
  expect(backfill).toBeDefined();
  const store = new NotificationStore(pool);
  for (const view of ['saved', 'done'] as const) for (const descending of [false, true]) {
    const page = await store.readStream(backfill.principal, null, 2, { view, reason: 'manual' },
      descending ? 'latest' : undefined);
    expect(page.items.map(item => item.id)).toEqual([backfill.itemId]);
    expect(page.items[0]).toMatchObject({ saved: true, done: true });
    expect(page.next).toBeNull();
  }
});

test('owner triage writes maintain filtered membership, preserve omitted flags and reject stale revisions', async () => {
  const f = await inbox();
  await f.insert([{ sequence: '1', saved: false, done: false, reason: 'manual' }], '1',
    { triage: false, context: false, erase: false });
  f.store.setDefaultReadSubjectReader({ async resolve() {
    return { status: 'available', subject: { private: false, fields: { title: 'Proposal' } } };
  } });
  const itemId = f.rows[0]!.id;
  async function membership(expected: { inbox: boolean; saved: boolean; done: boolean }, reason?: 'manual') {
    for (const view of ['inbox', 'saved', 'done'] as const) for (const descending of [false, true]) {
      const page = await f.store.readStream(f.principal, null, 2, { view, ...(reason ? { reason } : {}) },
        descending ? 'latest' : undefined);
      expect(page.items.map(item => item.id)).toEqual(expected[view] ? [itemId] : []);
    }
  }
  await membership({ inbox: true, saved: false, done: false });
  expect(await f.store.setItemTriage(f.principal, itemId, { saved: true, expectedRevision: null }))
    .toMatchObject({ saved: true, done: false, revision: '1' });
  await membership({ inbox: true, saved: true, done: false });
  expect(await f.store.setItemTriage(f.principal, itemId, { done: true, expectedRevision: '1' }))
    .toMatchObject({ saved: true, done: true, revision: '2' });
  await membership({ inbox: false, saved: true, done: true });
  await expect(f.store.setItemTriage(f.principal, itemId, { saved: false, done: false, expectedRevision: '1' }))
    .rejects.toBeInstanceOf(NotificationStale);
  await membership({ inbox: false, saved: true, done: true });
  expect(await f.store.setItemTriage(f.principal, itemId, { saved: false, expectedRevision: '2' }))
    .toMatchObject({ saved: false, done: true, revision: '3' });
  await membership({ inbox: false, saved: false, done: true });
  await membership({ inbox: false, saved: false, done: false }, 'manual');
  await pool.query(`INSERT INTO access.notification_proposal_context (item_id,proposal,revision,reason)
    VALUES ($1,$2,1,'manual')`, [itemId, f.proposal]);
  await membership({ inbox: false, saved: false, done: true }, 'manual');
  expect(await f.store.setItemTriage(f.principal, itemId, { done: false, expectedRevision: '3' }))
    .toMatchObject({ saved: false, done: false, revision: '4' });
  await membership({ inbox: true, saved: false, done: false }, 'manual');
});

for (const selection of selections) for (const descending of [true, false]) {
  test(`${descending ? 'descending' : 'forward'} ${JSON.stringify(selection)} reaches every sparse match once in PostgreSQL`, async () => {
    const f = await inbox();
    await f.insert(f.sparse(), '20000');
    const matching = f.rows.filter(row => matches(row, selection));
    if (descending) matching.reverse();
    const seen: string[] = [];
    let continuation: string | null = descending ? 'latest' : null;
    for (let pages = 0; pages < 4; pages++) {
      const after = !descending && continuation ? { generation: continuation.split(':')[0]!,
        sequence: continuation.split(':')[1]! } : null;
      const page = await f.store.readStream(f.principal, after, 50, selection, descending ? continuation! : undefined);
      expect(page.items.map(item => item.id)).toEqual(matching.slice(seen.length, seen.length + 50).map(row => row.id));
      seen.push(...page.items.map(item => item.id));
      continuation = page.next;
      if (continuation === null) break;
      if (descending) expect(continuation).not.toMatch(/^\d+:\d+$/);
    }
    expect(continuation).toBeNull();
    expect(seen).toHaveLength(123);
    expect(new Set(seen).size).toBe(123);
    expect(seen.at(-1)).toBe(matching.at(-1)!.id);
    expect(f.statements).toHaveLength(3);
  });
}

test('descending cursors bind recipient and filters, reject malformed input and mixing directions', async () => {
  const f = await inbox(); await f.insert(f.sparse(), '20000');
  const page = await f.store.readStream(f.principal, null, 2, { view: 'saved' }, 'latest');
  expect(page.next).not.toBeNull();
  await expect(f.store.readStream(f.principal, null, 2, { view: 'done' }, page.next!)).rejects.toBeInstanceOf(NotificationInvalid);
  await expect(f.store.readStream({ ...f.principal, subject: 'other' }, null, 2, { view: 'saved' }, page.next!))
    .rejects.toBeInstanceOf(NotificationInvalid);
  await expect(f.store.readStream(f.principal, null, 2, {}, 'bad-cursor')).rejects.toBeInstanceOf(NotificationInvalid);
  await expect(f.store.readStream(f.principal, { generation: '1', sequence: '0' }, 2, {}, 'latest'))
    .rejects.toBeInstanceOf(NotificationInvalid);
});

test('descending continuation resets from newest in a new generation, and stale or denied reads fail', async () => {
  const f = await inbox(); await f.insert(f.sparse(), '20000');
  const first = await f.store.readStream(f.principal, null, 2, {}, 'latest');
  await f.reset();
  const reset = await f.store.readStream(f.principal, null, 2, {}, first.next!);
  expect(reset.reset).toBe(true);
  expect(reset.generation).toBe('2');
  expect(reset.items.map(item => item.sequence)).toEqual(first.items.map(item => item.sequence));
  await f.deny();
  await expect(f.store.readStream(f.principal, null, 2, {}, 'latest')).rejects.toBeInstanceOf(NotificationDenied);
  const stale = await inbox(); await stale.insert(stale.sparse(), '20000');
  await expect(stale.store.readStream(stale.principal, { generation: '2', sequence: '0' }, 2))
    .rejects.toBeInstanceOf(NotificationStale);
  expect(await f.store.readStream({ ...f.principal, subject: 'missing' }, null, 50, {}, 'latest'))
    .toMatchObject({ items: [], next: null });
});

test('a real concurrent arrival above the captured head waits for the next newest traversal', async () => {
  const f = await inbox(); await f.insert(f.sparse(), '20000');
  const store = new NotificationStore(recordingPool(f.statements, async () => {
    await f.insert([{ sequence: '20001', saved: true, done: false, reason: 'manual' }]);
  }));
  const first = await store.readStream(f.principal, null, 2, { view: 'saved' }, 'latest');
  expect(first.head).toBe('20000');
  expect(first.items.map(item => item.sequence)).toEqual(['17395', '17253']);
  const newest = await store.readStream(f.principal, null, 2, { view: 'saved' }, 'latest');
  expect(newest.items[0]!.sequence).toBe('20001');
});

test('HTTP exposes newest-first continuations and fences unread counts with the current generation', async () => {
  const f = await inbox(); await f.insert(f.sparse(), '20000');
  const app = notificationRoutes({ account: { verify: async () => f.principal }, notifications: { store: f.store } } as unknown as MainWorkDependencies);
  const request = (before: string) => app.handle(new Request(
    `http://localhost/v1/me/notifications?view=saved&limit=2&before=${encodeURIComponent(before)}`));
  const first = await request('latest'); expect(first.status).toBe(200);
  const body = await first.json();
  expect(body.items.map((item: { sequence: string }) => item.sequence)).toEqual(['17395', '17253']);
  const next = await request(body.next); expect(next.status).toBe(200);
  expect((await next.json()).items.map((item: { sequence: string }) => item.sequence)).toEqual(['17111', '16969']);
  expect((await app.handle(new Request('http://localhost/v1/me/notifications?after=1:0&before=latest'))).status).toBe(400);
  const count = () => app.handle(new Request('http://localhost/v1/me/notifications/unread-count'));
  expect(await (await count()).json()).toMatchObject({ generation: '1', count: 0 });
  await f.reset();
  expect(await (await count()).json()).toMatchObject({ generation: '2', count: 0 });
});

test('unread count keeps one generation snapshot across a concurrent stream reset', async () => {
  const f = await inbox();
  await f.insert([{ sequence: '1', saved: false, done: false, reason: 'manual' }], '1',
    { triage: true, context: true, erase: false });
  let attempted = false, reset = false;
  const store = new NotificationStore(recordingPool([], undefined, async () => {
    attempted = true;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A snapshot that locks the stream may defer the reset until its read ends.
      await client.query("SELECT 1 FROM access.notification_stream WHERE principal_id = $1 AND stream = 'inbox' FOR UPDATE NOWAIT", [f.id]);
      await client.query("UPDATE access.notification_stream SET generation = generation + 1,head_sequence = 0,reset_at = now() WHERE principal_id = $1 AND stream = 'inbox'", [f.id]);
      await client.query('COMMIT');
      reset = true;
    } catch (error) {
      await client.query('ROLLBACK');
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '55P03') throw error;
    } finally { client.release(); }
  }));
  store.setDefaultReadSubjectReader({ resolve: async () => ({ status: 'available', subject: { fields: {}, private: true } }) });
  expect(await store.unreadCount(f.principal)).toEqual({ generation: '1', count: 1, overflow: false });
  expect(attempted).toBe(true);
  if (!reset) await f.reset();
  expect(await store.unreadCount(f.principal)).toEqual({ generation: '2', count: 0, overflow: false });
});

test('pagination fixtures obtain Agents and editorial records through their owners', () => {
  const source = readFileSync(import.meta.path, 'utf8');
  expect(source).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+access\.(?:authority_subject|agent_provision|editorial_proposal|editorial_revision)\b/i);
});

type Plan = { 'Node Type': string; 'Index Name'?: string; 'Actual Rows': number; 'Actual Loops': number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks': number; 'Shared Read Blocks': number; Plans?: Plan[] };
function planNodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(planNodes)]; }

test('live filter bounds retain memberships across extrema removal, empty views and later recovery', async () => {
  const f = await inbox();
  await f.insert([
    { sequence: '1', saved: true, done: false, reason: 'manual' },
    { sequence: '2', saved: false, done: false, reason: 'manual' },
    { sequence: '3', saved: true, done: false, reason: 'reviewer' },
  ], '3', { triage: true, context: true, erase: false, splitTriage: true });
  const bounds = async (view: string, reason = '') => (await pool.query(`
    SELECT lower_sequence::text AS lower, upper_sequence::text AS upper FROM access.notification_filter_bounds
    WHERE principal_id = $1 AND generation = 1 AND view = $2 AND reason = $3`, [f.id, view, reason])).rows[0];
  const page = (view: Selection['view'], descending: boolean, reason?: Selection['reason']) =>
    f.store.readStream(f.principal, null, 5, { view, reason }, descending ? 'latest' : undefined);
  expect(await bounds('saved')).toEqual({ lower: '1', upper: '3' });
  await f.store.setItemTriage(f.principal, f.rows[2]!.id, { saved: false, expectedRevision: '1' });
  expect(await bounds('saved')).toEqual({ lower: '1', upper: '1' });
  expect(await bounds('saved', 'reviewer')).toEqual({ lower: null, upper: null });
  await f.store.setItemTriage(f.principal, f.rows[0]!.id, { done: true, expectedRevision: '1' });
  expect(await bounds('inbox')).toEqual({ lower: '2', upper: '3' });
  await f.store.setItemTriage(f.principal, f.rows[2]!.id, { done: true, expectedRevision: '2' });
  expect(await bounds('inbox')).toEqual({ lower: '2', upper: '2' });
  await f.store.setItemTriage(f.principal, f.rows[1]!.id, { done: true, expectedRevision: '1' });
  expect(await bounds('inbox')).toEqual({ lower: null, upper: null });
  for (const descending of [false, true]) expect((await page('inbox', descending)).items).toEqual([]);
  await f.store.setItemTriage(f.principal, f.rows[1]!.id, { done: false, expectedRevision: '2' });
  expect(await bounds('inbox', 'manual')).toEqual({ lower: '2', upper: '2' });
  for (const descending of [false, true]) {
    expect((await page('inbox', descending, 'manual')).items.map(item => item.sequence)).toEqual(['2']);
    expect((await page('inbox', descending, 'reviewer')).items).toEqual([]);
    expect((await page('saved', descending, 'manual')).items.map(item => item.sequence)).toEqual(['1']);
  }
  await Promise.all([
    f.store.setItemTriage(f.principal, f.rows[0]!.id, { saved: false, expectedRevision: '2' }),
    f.store.setItemTriage(f.principal, f.rows[2]!.id, { saved: true, expectedRevision: '3' }),
  ]);
  expect(await bounds('saved')).toEqual({ lower: '3', upper: '3' });
  expect(await bounds('saved', 'manual')).toEqual({ lower: null, upper: null });
  expect(await bounds('saved', 'reviewer')).toEqual({ lower: '3', upper: '3' });
});

test('production-shaped committed enqueue then triage uses bounded filtered seeks at three history sizes', async () => {
  const proof: unknown[] = [];
  for (const view of ['inbox', 'saved', 'done'] as const) for (const withReason of [false, true]) {
    const f = await inbox();
    const selection: Selection = { view, ...(withReason ? { reason: 'manual' as const } : {}) };
    const old = { sequence: '1', saved: view === 'saved', done: view === 'done', reason: 'manual' };
    const splitTriage = { triage: true, context: true, erase: true, splitTriage: true };
    await f.insert([old], undefined, splitTriage);
    const metrics: Record<string, { visited: number; buffers: number }[]> = { forward: [], descending: [] };
    let inserted = 0;
    for (const history of [1000, 4000, 16000]) {
      await f.insert(Array.from({ length: history - inserted }, (_, offset) => ({
        sequence: String(inserted + offset + 2), saved: withReason ? old.saved : false,
        done: withReason ? old.done : view === 'inbox', reason: 'reviewer',
      })), undefined, splitTriage);
      inserted = history;
      for (const descending of [false, true]) {
        const page = await f.store.readStream(f.principal, null, 2, selection, descending ? 'latest' : undefined);
        expect(page.items.map(item => item.sequence)).toEqual(['1']);
        const statement = f.statements.at(-1)!;
        const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.args))
          .rows[0]!['QUERY PLAN'][0].Plan as Plan;
        const nodes = planNodes(plan);
        const visited = nodes.reduce((sum, node) => sum + (node['Actual Rows']
          + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'], 0);
        const buffers = plan['Shared Hit Blocks'] + plan['Shared Read Blocks'];
        const direction = descending ? 'descending' : 'forward';
        metrics[direction]!.push({ visited, buffers });
        proof.push({ selection, direction, history, visited, buffers, statement, plan });
        writeFileSync(join(root, '.temp/notification-filter-seek-plans.json'), JSON.stringify(proof, null, 2));
        expect(nodes.map(node => node['Index Name'])).toContain(`notification_filter_${view}${withReason ? '_reason' : ''}`);
        expect(visited).toBeLessThanOrEqual(40);
        expect(buffers).toBeLessThanOrEqual(60);
      }
    }
    for (const direction of ['forward', 'descending']) {
      const measurements = metrics[direction]!;
      expect(Math.max(...measurements.map(m => m.visited)) - Math.min(...measurements.map(m => m.visited))).toBeLessThanOrEqual(4);
      expect(Math.max(...measurements.map(m => m.buffers)) - Math.min(...measurements.map(m => m.buffers))).toBeLessThanOrEqual(8);
    }
  }
}, 90_000);

test('a non-strict descending seek duplicates the previous page boundary in real SQL', async () => {
  const f = await inbox(); await f.insert(f.sparse(), '20000');
  const first = await f.store.readStream(f.principal, null, 2, { view: 'saved' }, 'latest');
  const second = await f.store.readStream(f.principal, null, 2, { view: 'saved' }, first.next!);
  expect(second.items.some(item => item.id === first.items.at(-1)!.id)).toBe(false);
  const statement = f.statements.at(-1)!;
  const nonStrict = statement.sql.replace(/([if]\.sequence) < \$3\b/, '$1 <= $3');
  expect(nonStrict).not.toBe(statement.sql);
  const mutant = await pool.query(nonStrict, statement.args);
  expect(mutant.rows[0]!.id).toBe(first.items.at(-1)!.id);
});
