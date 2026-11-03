import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { readErasureStatus } from '../../../src/access/erasure.ts';
import { createCollectionJob } from '../../../src/content/collection-job.ts';
import { createContentWorkAccess } from '../../../src/content/register.ts';
import { contentEffects } from '../../../src/content/relays.ts';
import { R2Storage } from '../../../src/content/r2-storage.ts';
import { createContentWork, CONTENT_BOARD_RANK_SCHEDULE, CONTENT_COLLECTION_SCHEDULE, CONTENT_NOTICE_RETENTION_SCHEDULE } from '../../../src/content/work.ts';
import type { MediaStorage } from '../../../src/content/media-storage.ts';
import { relayEffects } from '../../../src/events/effects.ts';
import type { CloudEvent } from '../../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createWorkClient, type WorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../../support/account-deletion.ts';
import { checkGrowth, assertGrowthAccessPaths, openGrowthDatabase, seed } from '../../support/growth.ts';
import { createNativeContentSystem } from './native-system.ts';
import { seedGovernanceAuthority } from './disclosure-fixtures.ts';

export const SCALES = [256, 1024, 4096] as const;
export const AXES = ['progress', 'content', 'history'] as const;
export type Axis = (typeof AXES)[number];
export type Mode = 'empty' | 'contributions';
type Person = { accountId: string; bearer: string; websiteBearer?: string };
type Thread = { id: string; firstPost: { id: string; revisionId: string } };
export type Selected = {
  axis: Axis; scale: number; mode: Mode; slot: number; person: Person; erasedAt?: string;
  published?: Thread; draft?: Thread; decisionId?: string; dueAt?: string; mediaId?: string;
};
type Continuation = { phase: string; step: number; delayMs?: number; retentionAt?: string | null };
const RUN = 'content.account-erasure.step';
const RETENTION = 'content.account-erasure.retention';
const PREFIX = 'erasure-growth-control:';
const DAY = 86_400_000;
const key = () => JSON.stringify(crypto.randomUUID());
const home = (id: string) => routeOf(id)!;

/** A private S3-shaped storage resource. Failure is at physical deletion, after
 * Collection commits its real pending fence; no content command is substituted. */
async function objectStore() {
  const objects = new Map<string, Buffer>();
  const failing = new Set<string>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname.startsWith('/fixture/')) {
      const id = url.searchParams.get('id')!;
      if (request.method === 'POST') failing.delete(id);
      response.end(JSON.stringify([...objects.keys()].filter((name) => name.startsWith(`m/${id}/`))));
      return;
    }
    const name = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/');
    if (request.method === 'GET' && url.searchParams.has('list-type')) {
      const names = [...objects.keys()].filter((item) => item.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      response.setHeader('content-type', 'application/xml');
      response.end(`<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${names.map((item) =>
        `<Contents><Key>${encodeURIComponent(item)}</Key><Size>${objects.get(item)!.length}</Size></Contents>`).join('')}</ListBucketResult>`);
    } else if (request.method === 'DELETE') {
      if ([...failing].some((id) => name.startsWith(`m/${id}/`))) response.writeHead(500).end();
      else { objects.delete(name); response.writeHead(204).end(); }
    } else if (request.method === 'GET') {
      const bytes = objects.get(name);
      if (bytes) response.end(bytes);
      else response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
    } else response.writeHead(405).end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const storage: MediaStorage = {
    async get(name) { return objects.get(name) ?? null; },
    async put(name, bytes) { objects.set(name, Buffer.from(bytes)); },
    async deletePrefix(prefix) {
      if ([...failing].some((id) => prefix === `m/${id}/`)) throw new Error('growth fixture storage deletion unavailable');
      for (const name of objects.keys()) if (name.startsWith(prefix)) objects.delete(name);
    },
  };
  return { endpoint: `http://127.0.0.1:${address.port}`, objects, failing, storage,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function startRunner(databaseUrl: string, endpoint: string, routeKey: Uint8Array) {
  const child = spawn(process.execPath, ['run', import.meta.filename, '--erasure-growth-worker'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, CONTENT_TEST_STORAGE: endpoint,
      CONTENT_TEST_ROUTE_KEY: Buffer.from(routeKey).toString('base64url') }, stdio: 'pipe',
  });
  let diagnostic = '';
  let serial = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let ready!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-12_000); });
  child.once('error', (error) => { rejectReady(error); for (const waiter of pending.values()) waiter.reject(error); });
  child.once('exit', (code) => {
    const error = new Error(`Erasure growth worker exited ${code}: ${diagnostic}`);
    rejectReady(error); for (const waiter of pending.values()) waiter.reject(error);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith(PREFIX)) { console.info(line); return; }
    const message = JSON.parse(line.slice(PREFIX.length));
    if (message.ready) return ready();
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.value);
  });
  const request = <T>(method: string, input?: unknown) => new Promise<T>((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, input })}\n`);
  });
  try { await started; } catch (error) { child.stdin.end(); await exited; throw error; }
  return { request, async close() { await request('stop'); child.stdin.end(); assert.equal(await exited, 0, diagnostic); } };
}

export async function participantFixture() {
  const system = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  const store = await objectStore();
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  const pool = system.database.pool;
  const staff: Person = { accountId: system.actors.other.actor.accountId, bearer: system.actors.other.bearer };
  async function call<T>(person: Person, method: string, path: string, body?: unknown, head?: string): Promise<T> {
    const response = await system.kernel.handle(new Request(`https://content.test${path}`, {
      method, headers: { authorization: `Bearer ${person.bearer}`, 'idempotency-key': key(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(head ? { 'if-match': JSON.stringify(head) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await response.text();
    assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const grant = (person: Person, id: string, actions: string[]) =>
    seedGovernanceAuthority(pool, home(id), id, person.accountId, actions);
  const selected: Selected[] = [];
  try {
    await bootstrapRelease(pool, bundledRelease);
    const { space } = await call<{ space: { spaceId: string } }>(staff, 'POST', '/v1/spaces', { title: 'Erasure growth', summary: '' });
    const { realm } = await call<{ realm: { realmId: string; headRevisionId: string } }>(staff, 'POST', '/v1/realms', {
      spaceId: space.spaceId, title: 'Erasure growth', visibility: 'public', contextId: GLOBAL_CONTEXT,
    });
    const { subject: scheme } = await call<{ subject: { id: string } }>(staff, 'POST', '/v1/subjects', {
      type: 'skos:ConceptScheme', labels: { en: 'Erasure growth' },
    });
    const { subject: concept } = await call<{ subject: { id: string } }>(staff, 'POST', '/v1/subjects', {
      type: 'skos:Concept', labels: { en: 'Erasure growth board' }, statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    });
    await call(staff, 'PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, realm.headRevisionId);
    const { board } = await call<{ board: { id: string } }>(staff, 'POST', `/v1/realms/${realm.realmId}/boards`, {
      conceptId: concept.id, title: 'Erasure growth board', visibility: 'published',
    });
    const createThread = async (person: Person, visibility: 'published' | 'draft') => {
      await grant(person, board.id, ['thread:create', 'board:read']);
      return (await call<{ thread: Thread }>(person, 'POST', '/v1/threads', {
        boardId: board.id, title: `Selected ${visibility}`, visibility,
        body: fromPlainText(`Selected ${visibility} body`), licence: 'CC0-1.0', subjectIds: [],
      })).thread;
    };
    const occupied = new Set([partitionOf(home(board.id))]);
    const targetAuthors = new Map<string, Person>();
    // Six states per cell cover the harness's warm-up, accepted run and four
    // possible cold-backend discards without resetting a lifecycle with SQL.
    for (const axis of AXES) for (const scale of SCALES) for (const mode of ['empty', 'contributions'] as const)
      for (let slot = 0; slot < 6; slot++) {
        let person: Person;
        do { person = await accountDeletionRuntime(system).person() as Person; }
        while (mode === 'contributions' && occupied.has(partitionOf(home(person.accountId))));
        const item: Selected = { axis, scale, mode, slot, person };
        selected.push(item);
        if (mode === 'empty') continue;
        occupied.add(partitionOf(home(person.accountId)));
        item.published = await createThread(person, 'published');
        item.draft = await createThread(person, 'draft');
        const group = `${axis}:${scale}`;
        let targetAuthor = targetAuthors.get(group);
        if (!targetAuthor) { targetAuthor = await accountDeletionRuntime(system).person(); targetAuthors.set(group, targetAuthor); }
        const target = await createThread(targetAuthor, 'published');
        await grant(person, target.firstPost.id, ['moderation:takedown']);
        await call(person, 'POST', `/v1/posts/${target.firstPost.id}:takeDown`, { reason: 'Retained complaint statement' });
        const decision = (await pool.query<{ decision_id: string; decided_at: Date }>(
          'SELECT decision_id::text,decided_at FROM content.moderation_decision WHERE route=$1 AND target_id=$2',
          [home(target.id), target.firstPost.id],
        )).rows[0]!;
        item.decisionId = decision.decision_id;
        item.dueAt = new Date(decision.decided_at.getTime() + 183 * DAY).toISOString();
        await grant(person, person.accountId, ['media:create']);
        await system.clock.setCommandTime(new Date(Date.now() - 2 * DAY).toISOString());
        const bytes = Buffer.from('isolated reserved upload bytes');
        const { media } = await call<{ media: { id: string } }>({ ...person, bearer: person.websiteBearer! }, 'POST', '/v1/media', {
          containerId: person.accountId, purpose: 'avatar', mediaType: 'image/png', byteCount: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        await system.clock.setCommandTime(new Date().toISOString());
        item.mediaId = media.id;
        store.objects.set(`m/${media.id}/original`, bytes);
        store.failing.add(media.id);
        await assert.rejects(createCollectionJob(pool, store.storage).collectPartition(partitionOf(home(media.id)), 10),
          /growth fixture storage deletion unavailable/);
        assert.equal((await pool.query('SELECT collection_pending FROM content.media WHERE route=$1 AND media_id=$2',
          [home(media.id), media.id])).rows[0].collection_pending, true);
      }
    runner = await startRunner(pool.options.connectionString!, store.endpoint, system.routeKey);
    // Index all ordinary source events while their authors are live. Auth keeps
    // its own executor; the registered Content executor lives in the child.
    await runner.request('relay');
    for (const item of selected) item.erasedAt = (await deletePersona({ pool, auth: accountDeletionRuntime(system).auth }, item.person)).at;
    await runner.request('relay');
    const running = runner;
    return { system, selected, async measure() {
      return running.request<{ reports: number; completed: string[]; revision: string }>('measure', selected);
    }, async close() { try { await running.close(); } finally { try { await store.close(); } finally { await system.close(); } } } };
  } catch (error) {
    try { await runner?.close(); } finally { try { await store.close(); } finally { await system.close(); } }
    throw error;
  }
}

/** Separate native executor, with all SQL observation in the process that does
 * the work. Queue delays select one durable workflow; they do not change a
 * lifecycle TTL or the production step's retry/sleep/page configuration. */
async function worker() {
  const db = await openGrowthDatabase();
  const client = await createWorkClient(db.url, db.pool);
  const enqueue = client.enqueue.bind(client);
  const held = new Set<string>();
  const endpoint = process.env.CONTENT_TEST_STORAGE!;
  let now = new Date();
  let prefixDeletes = 0;
  const storage = new R2Storage({ endpoint, bucket: 'media-test', accessKeyId: 'fixture', secretAccessKey: 'fixture-secret',
    maxObjectBytes: 20 * 1024 * 1024, fetch });
  const countedStorage: MediaStorage = { get: (name) => storage.get(name), put: (...args) => storage.put(...args),
    async deletePrefix(prefix) { prefixDeletes++; await storage.deletePrefix(prefix); } };
  client.enqueue = (async (options: Parameters<WorkClient['enqueue']>[0], ...args: unknown[]) => {
    if (options.workflowName === RUN || options.workflowName === RETENTION) {
      assert(options.workflowID);
      held.add(options.workflowID);
      return enqueue({ ...options, delaySeconds: 3600 }, ...args);
    }
    return enqueue(options, ...args);
  }) as WorkClient['enqueue'];
  const runtime = await composeWork([{ name: 'content', async register(context) {
    await createContentWork({ storage: countedStorage, access: createContentWorkAccess(() => now, db.pool),
      // Account cleanup is platform work. Fail if the selected participant
      // unexpectedly tries to restore an initiating caller's consent.
      readConsent: async () => { throw new Error('Unexpected initiator restoration in account participant'); },
      routeKey: Buffer.from(process.env.CONTENT_TEST_ROUTE_KEY!, 'base64url'), fetchConfig: { allowedHosts: [] },
    }).register(context);
    context.addEffects(contentEffects(db.pool, client));
  } }], { databaseUrl: db.url, pool: db.pool, client, clock: () => now });
  for (const name of [CONTENT_COLLECTION_SCHEDULE, CONTENT_BOARD_RANK_SCHEDULE, CONTENT_NOTICE_RETENTION_SCHEDULE]) {
    if (await client.getSchedule(name)) await client.pauseSchedule(name);
  }
  await runtime.launch();
  const progress = async (item: Selected) => (await db.pool.query<{ phase: string; step: string; cursor: unknown }>(
    'SELECT phase,step::text,cursor FROM content.account_erasure_progress WHERE route=$1 AND account_id=$2',
    [home(item.person.accountId), item.person.accountId],
  )).rows[0];
  async function relay(partition: number) {
    const before = (await db.pool.query<{ position: string }>(
      "SELECT position::text FROM core.consumer_checkpoint WHERE consumer='effects' AND partition_no=$1", [partition],
    )).rows[0]?.position ?? '0';
    for (;;) {
      const result = await relayEffects(db.pool, runtime.effects, partition);
      assert.notEqual(result.status, 'stopped', JSON.stringify(result));
      if (result.status === 'read' && result.envelopes === 0) break;
    }
    await drainEffects(db.pool, partition);
    const jobs = await db.pool.query<{ workflow_id: string }>(
      `SELECT workflow_id FROM core.history_event_consumer WHERE partition_no=$1 AND position>$2 ORDER BY position,event_seq,consumer`,
      [partition, before],
    );
    for (const job of jobs.rows) await client.retrieveWorkflow(job.workflow_id).getResult();
    // A post-erased effect enqueues physical revision cleanup separately.
    const purges = await db.pool.query<{ id: string }>(
      `SELECT id::text FROM core.outbox WHERE partition_no=$1 AND position>$2 AND type='com.rezics.content.post.erased.v1'`,
      [partition, before],
    );
    for (const event of purges.rows) await client.retrieveWorkflow(`content.erasePost:${event.id}`).getResult();
  }
  async function relayAll() {
    const parts = await db.pool.query<{ partition_no: number }>('SELECT partition_no FROM core.partition WHERE position>0');
    for (const part of parts.rows) await relay(part.partition_no);
  }
  const workflowId = (item: Selected, phase: string, step: number) => `content-account-erasure:${item.person.accountId}:${phase}:${step}`;
  async function selectedStep(item: Selected, phase: string, step: number, delayed = false) {
    const id = workflowId(item, phase, step);
    assert(held.has(id), `Registered continuation missing: ${id}`);
    await client.setWorkflowDelay(id, 0);
    const handle = client.retrieveWorkflow(id);
    if (delayed) {
      // Observe the actual durable sleep before cancelling this test-owned
      // sleeper. Settlement resumes the persisted next step, as the native
      // account-erasure regression fixture does; no ten-minute TTL is shortened.
      const deadline = Date.now() + 30_000;
      for (;;) {
        const steps = (await client.listWorkflowSteps(id)) ?? [];
        if (steps.some((entry) => entry.name !== 'content.account-erasure.run')) break;
        assert(Date.now() < deadline, `Native pending sleep was not recorded: ${id}`);
        await Bun.sleep(25);
      }
      await client.cancelWorkflow(id);
      await assert.rejects(handle.getResult());
    } else await handle.getResult();
    const steps = (await client.listWorkflowSteps(id)) ?? [];
    const native = steps.filter((entry) => entry.name === 'content.account-erasure.run');
    assert.equal(native.length, 1);
    assert.equal(native[0]!.error, null);
    const output = native[0]!.output as Continuation;
    if (delayed) {
      assert.equal(output.delayMs, 600_000);
      // The cancelled workflow slept before enqueueing. Persist the original
      // continuation under its production identity, through the original SDK.
      await client.enqueue({ workflowName: RUN, queueName: 'governance', workflowID: workflowId(item, output.phase, output.step),
        workflowIDReusePolicy: 'return-existing' }, item.person.accountId, output.step);
    }
    if (phase === 'authored') await relay(partitionOf(home(item.published?.id ?? item.person.accountId)));
    return { id, output, steps };
  }

  let retainedSources = 0;
  let sourceSnapshot: { post: Record<string, unknown>; revision: Record<string, unknown>; decision: Record<string, unknown> } | undefined;
  const pressure: { route: number; account: string; post: string; revision: string; decision: string }[] = [];
  async function grow(axis: Axis, scale: number, previous: number, template: Selected) {
    if (previous === 0 && pressure.length) {
      const ids = pressure.map((item) => item.account);
      await db.admin.query('DELETE FROM content.account_erasure_progress WHERE account_id=ANY($1::uuid[])', [ids]);
      await db.admin.query('DELETE FROM content.author_item WHERE author_account_id=ANY($1::uuid[])', [ids]);
      await db.admin.query('DELETE FROM content.account_erasure_statement WHERE account_id=ANY($1::uuid[])', [ids]);
      // Revision identities are immutable. Prior cohorts remain a fixed source
      // baseline throughout this series; only our removable locator cohort resets.
      await db.admin.query('DELETE FROM content.moderation_decision WHERE decision_id=ANY($1::uuid[])', [pressure.map((item) => item.decision)]);
      pressure.length = 0;
    }
    const source = template.published!;
    sourceSnapshot ??= { post: (await db.admin.query('SELECT * FROM content.post WHERE route=$1 AND post_id=$2', [home(source.id), source.firstPost.id])).rows[0], revision: (await db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 AND revision_id=$3',
      [home(source.id), source.firstPost.id, source.firstPost.revisionId])).rows[0], decision: (await db.admin.query('SELECT * FROM content.moderation_decision WHERE route=$1 AND decision_id=$2',
      [home(template.decisionId!), template.decisionId])).rows[0] };
    const { post, revision, decision } = sourceSnapshot;
    const pending = Array.from({ length: scale - previous }, () => {
      const route = home(source.id);
      return { route, account: newId(route), post: newId(route), revision: newId(route), decision: newId(route) };
    });
    await seed({ pool: db.pool, admin: db.admin }, { name: `account-participant-${axis}`, hotPartition: partitionOf(home(source.id)), hotShare: 1,
      rows({ ordinal }) {
        const row = pending[ordinal - previous]!;
        if (axis === 'progress') return { 'content.account_erasure_progress': [{ route: row.route, account_id: row.account,
          phase: 'complete', step: 42, cursor: null, erased_at: template.erasedAt }] };
        if (axis === 'content') return {
          'content.post': [{ ...post, post_id: row.post, head_revision_id: row.revision, author_account_id: row.account, author_erased: false }],
          'content.revision': [{ ...revision, post_id: row.post, revision_id: row.revision }],
          'content.author_item': [{ route: row.route, author_account_id: row.account, item_kind: 'post', item_id: row.post,
            thread_id: source.id, thread_kind: 'discussion', created_at: template.erasedAt, source_epoch: 1, source_position: 1 }],
        };
        return {
          'content.moderation_decision': [{ ...decision, decision_id: row.decision, decider_account_id: null }],
          'content.account_erasure_statement': [{ route: row.route, account_id: row.account, due_at: template.dueAt,
            owner_route: row.route, decision_id: row.decision }],
        };
      },
    }, { from: previous, to: scale });
    if (axis === 'content') retainedSources += pending.length;
    pressure.push(...pending);
    assert.equal(pressure.length, scale);
    if (axis === 'content') {
      for (const [relation, column, ids] of [
        ['post', 'post_id', pressure.map((row) => row.post)],
        ['revision', 'revision_id', pressure.map((row) => row.revision)],
      ] as const) {
        const rows = await db.admin.query(`SELECT count(*)::int AS n FROM content.${relation} WHERE ${column}=ANY($1::uuid[])`, [ids]);
        assert.equal(rows.rows[0].n, scale);
      }
    }
    const relation = axis === 'progress' ? 'account_erasure_progress' : axis === 'content' ? 'author_item' : 'account_erasure_statement';
    const column = axis === 'content' ? 'author_account_id' : 'account_id';
    assert.equal((await db.admin.query(`SELECT count(*)::int AS n FROM content.${relation} WHERE ${column}=ANY($1::uuid[])`,
      [pressure.map((row) => row.account)])).rows[0].n, scale);
    console.info('Content account erasure population', JSON.stringify({ axis, scale, rows: pressure.length, retainedSourceBaseline: axis === 'content' ? retainedSources - scale : retainedSources }));
  }

  type Stage = { name: string; phase?: string; step?: number; delayed?: boolean; probes: number };
  const common: Stage[] = [
    { name: 'fence-close', phase: 'close', step: 0, probes: 12 },
    { name: 'authored', phase: 'authored', step: 1, probes: 12 + 50 * 6 + 100 },
    { name: 'uploads-media', phase: 'uploads', step: 2, probes: 12 + 50 * 8 },
  ];
  const tail = (offset: number): Stage[] => [
    { name: 'reactions-reports', phase: 'reactions', step: 4 + offset, probes: 12 + 50 * 8 },
    { name: 'moderation', phase: 'moderation', step: 5 + offset, probes: 12 + 50 * 8 },
    { name: 'proof-media', phase: 'proof', step: 6 + offset, probes: 12 + 6 + 50 * 8 },
    { name: 'proof-fields-acknowledge', phase: 'proof', step: 7 + offset, probes: 24 + 50 * 8 },
    { name: 'tombstone-replay', probes: 12 },
  ];
  const stages = (mode: Mode): Stage[] => mode === 'empty' ? [...common,
    { name: 'uploads-fields-delivery', phase: 'uploads', step: 3, probes: 24 + 50 * 8 }, ...tail(0),
  ] : [...common,
    { name: 'pending-collection-delay', phase: 'uploads', step: 3, delayed: true, probes: 12 + 50 * 8 },
    { name: 'registered-collection-settlement', probes: 16 * 2 + 100 * 8 },
    { name: 'settled-uploads-media', phase: 'uploads', step: 4, probes: 12 + 50 * 8 },
    { name: 'settled-uploads-fields-delivery', phase: 'uploads', step: 5, probes: 24 + 50 * 8 }, ...tail(2),
    { name: 'retention-expiry', probes: 12 + 50 * 8 },
  ];
  const reached = new Map<string, number>();
  const completed = new Set<string>();
  async function acknowledgement(item: Selected) {
    const rows = await db.pool.query<{ participant: string; outcome: string; retained: unknown }>(
      `SELECT participant,outcome,retained FROM access.erasure_acknowledgement
       WHERE route=$1 AND account_id=$2 AND participant IN ('content','delivery') ORDER BY participant`,
      [home(item.person.accountId), item.person.accountId],
    );
    return rows.rows;
  }
  async function execute(item: Selected, stage: Stage) {
    const beforeDeletes = prefixDeletes;
    let nativeSteps = 0;
    let selectedId = '';
    let output: unknown;
    if (stage.phase !== undefined) {
      const result = await selectedStep(item, stage.phase, stage.step!, stage.delayed);
      selectedId = result.id;
      nativeSteps = result.steps.length;
      output = result.output;
      assert.equal((await progress(item))?.step, String(stage.step! + 1));
      if (stage.phase === 'close') {
        assert((await db.pool.query('SELECT closed_at FROM content.erasure_fence WHERE route=$1 AND account_id=$2',
          [home(item.person.accountId), item.person.accountId])).rows[0]?.closed_at);
      }
      if (stage.name === 'pending-collection-delay') {
        const status = await readErasureStatus(db.pool, item.person.accountId);
        assert.equal(status?.participants.content?.outcome, 'pending');
        assert.equal(status?.participants.delivery?.outcome, 'pending');
        assert.deepEqual(await acknowledgement(item), []);
        const objects = await fetch(`${endpoint}/fixture/objects?id=${item.mediaId}`).then((response) => response.json());
        assert.deepEqual(objects, [`m/${item.mediaId}/original`]);
      }
      if (stage.name === 'authored' && item.mode === 'contributions') {
        assert.deepEqual((await db.pool.query('SELECT availability,author_erased FROM content.post WHERE route=$1 AND post_id=$2',
          [home(item.published!.id), item.published!.firstPost.id])).rows[0], { availability: 'available', author_erased: true });
        assert.equal((await db.pool.query('SELECT title FROM content.thread WHERE route=$1 AND thread_id=$2',
          [home(item.draft!.id), item.draft!.id])).rows[0].title, null);
        const bodies = await db.pool.query('SELECT body,search_text FROM content.revision WHERE route=$1 AND post_id=$2',
          [home(item.draft!.id), item.draft!.firstPost.id]);
        assert(bodies.rows.every((row) => row.body === null && row.search_text === null));
        assert.equal((await db.pool.query('SELECT purge_completed FROM content.post WHERE route=$1 AND post_id=$2',
          [home(item.draft!.id), item.draft!.firstPost.id])).rows[0].purge_completed, true);
      }
      if (stage.name === 'proof-fields-acknowledge') {
        const status = await readErasureStatus(db.pool, item.person.accountId);
        const outcome = item.mode === 'empty' ? 'none' : 'erased';
        assert.equal(status?.participants.content?.outcome, outcome);
        assert.equal(status?.participants.delivery?.outcome, outcome);
        assert.equal((await acknowledgement(item)).length, 2);
        const retained = status!.participants.content!.retained;
        if (item.mode === 'contributions') {
          assert.equal(retained.length, 1);
          assert.deepEqual(retained[0]!.fields, ['statement']);
          assert.equal(retained[0]!.store, 'content.moderation_decision');
          assert.equal(retained[0]!.expiresAt, item.dueAt);
          assert.equal(retained[0]!.resolvedAt, null);
          assert.deepEqual((await db.pool.query('SELECT decider_account_id,statement FROM content.moderation_decision WHERE route=$1 AND decision_id=$2',
            [home(item.decisionId!), item.decisionId])).rows[0], { decider_account_id: null, statement: 'Retained complaint statement' });
        } else assert.deepEqual(retained, []);
        completed.add(item.person.accountId);
      }
    } else if (stage.name === 'registered-collection-settlement') {
      await fetch(`${endpoint}/fixture/release?id=${item.mediaId}`, { method: 'POST' });
      const id = `growth-collection:${item.person.accountId}`;
      const handle = await enqueue({ workflowName: 'content.collect.partition', queueName: 'maintenance', workflowID: id },
        partitionOf(home(item.mediaId!)));
      await handle.getResult();
      const steps = (await client.listWorkflowSteps(id))!;
      const batches = steps.filter((entry) => entry.name === 'content.collect.step');
      assert.equal(batches.length, 1);
      assert.deepEqual(batches[0]!.output, { partition: partitionOf(home(item.mediaId!)), examined: 1, collected: 1, complete: true });
      await relay(partitionOf(home(item.mediaId!)));
      assert.deepEqual(await fetch(`${endpoint}/fixture/objects?id=${item.mediaId}`).then((response) => response.json()), []);
      assert.equal((await db.pool.query('SELECT 1 FROM content.media WHERE route=$1 AND media_id=$2', [home(item.mediaId!), item.mediaId])).rowCount, 0);
      assert.equal((await readErasureStatus(db.pool, item.person.accountId))?.participants.content?.outcome, 'pending');
      selectedId = id; nativeSteps = steps.length; output = batches[0]!.output;
    } else if (stage.name === 'tombstone-replay') {
      const before = await acknowledgement(item);
      const state = await progress(item);
      const row = (await db.pool.query<{
        partition_no: number; epoch: number; id: string; type: string; position: string; data: unknown; recorded_at: Date;
      }>(`SELECT partition_no,epoch,id::text,type,position::text,data,recorded_at FROM core.outbox
        WHERE partition_no=$1 AND type='com.rezics.access.account-tombstoned.v1' AND data->>'accountId'=$2`,
        [partitionOf(home(item.person.accountId)), item.person.accountId])).rows[0]!;
      assert(row);
      const event: CloudEvent = { specversion: '1.0', id: row.id, type: row.type, source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
        sequence: row.position.padStart(19, '0'), time: row.recorded_at.toISOString(), data: row.data, datacontenttype: 'application/json' };
      const id = `growth-replay:${item.person.accountId}`;
      const handle = await enqueue({ workflowName: 'effect', queueName: 'effects', workflowID: id }, 'content_account_erasure', event);
      await handle.getResult();
      const steps = (await client.listWorkflowSteps(id))!;
      assert.equal(steps.filter((entry) => entry.name === 'effect.run').length, 1);
      assert.equal((await client.getWorkflow(workflowId(item, 'close', 0)))?.status, 'SUCCESS');
      assert.deepEqual(await acknowledgement(item), before);
      assert.deepEqual(await progress(item), state);
      const jobs = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM dbos.workflow_status WHERE workflow_uuid=$1`, [workflowId(item, 'close', 0)]);
      assert.equal(jobs.rows[0]!.n, 1);
      selectedId = id; nativeSteps = steps.length; output = { acknowledgements: before };
    } else if (stage.name === 'retention-expiry') {
      now = new Date(Date.parse(item.dueAt!) + 1);
      const id = `content-account-erasure:${item.person.accountId}:retention:${item.dueAt}`;
      assert(held.has(id));
      await client.setWorkflowDelay(id, 0);
      await client.retrieveWorkflow(id).getResult();
      const steps = (await client.listWorkflowSteps(id))!;
      assert.equal(steps.filter((entry) => entry.name === 'content.account-erasure.retention-page').length, 1);
      assert.equal((await db.pool.query('SELECT statement FROM content.moderation_decision WHERE route=$1 AND decision_id=$2',
        [home(item.decisionId!), item.decisionId])).rows[0].statement, '');
      assert.equal((await db.pool.query('SELECT 1 FROM content.account_erasure_statement WHERE route=$1 AND account_id=$2',
        [home(item.person.accountId), item.person.accountId])).rowCount, 0);
      const status = await readErasureStatus(db.pool, item.person.accountId);
      assert(status?.participants.content?.retained[0]?.resolvedAt);
      selectedId = id; nativeSteps = steps.length; output = status?.participants.content;
    }
    assert(nativeSteps > 0, `Registered work missing for ${stage.name}`);
    const index = (reached.get(item.person.accountId) ?? 0) + 1;
    reached.set(item.person.accountId, index);
    console.info('Content account erasure registered operation', JSON.stringify({ axis: item.axis, scale: item.scale,
      mode: item.mode, slot: item.slot, accountId: item.person.accountId, stage: stage.name, selectedId, nativeSteps, output }));
    return { nativeSteps, prefixDeletes: prefixDeletes - beforeDeletes };
  }
  async function measure(selected: Selected[]) {
    let reports = 0;
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(revision.status, 0, revision.stderr);
    console.info('Content account erasure execution binding', JSON.stringify({ revision: revision.stdout.trim(),
      command: 'bun run --cwd services/kernel check test/content/growth-account-erasure-participant.test.ts',
      axes: AXES, scales: SCALES, fixturesPerCell: 6, repetitions: 1,
      limits: 'Fixed selected steps only; Accounts orchestration, total account-size growth and real-time waiting are not measured.' }));
    const template = selected.find((item) => item.mode === 'contributions')!;
    for (const axis of AXES) for (const mode of ['empty', 'contributions'] as const) {
      const sequence = stages(mode);
      for (const [stageIndex, stage] of sequence.entries()) {
        const slots = new Map<number, number>();
        let prepared: Selected | undefined;
        const prepare = async (scale: number) => {
          const slot = slots.get(scale) ?? 0;
          slots.set(scale, slot + 1);
          prepared = selected.find((item) => item.axis === axis && item.mode === mode && item.scale === scale && item.slot === slot);
          assert(prepared, `Exhausted six native lifecycle states: ${axis}/${mode}/${scale}/${stage.name}`);
          while ((reached.get(prepared.person.accountId) ?? 0) < stageIndex)
            await execute(prepared, sequence[reached.get(prepared.person.accountId) ?? 0]!);
          assert.equal(reached.get(prepared.person.accountId) ?? 0, stageIndex);
          now = stage.name === 'retention-expiry' ? new Date(Date.parse(prepared.dueAt!) + 1) : new Date();
        };
        const operation = async () => { assert(prepared); return execute(prepared, stage); };
        const name = `Content account participant ${axis}/${mode}/${stage.name}`;
        const report = await checkGrowth(db, { name, rule: 'series', scales: SCALES, repetitions: 1,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' }, indexProbes: stage.probes,
          counted: { read: (value) => value as { nativeSteps: number; prefixDeletes: number },
            bounds: { nativeSteps: 'constant', prefixDeletes: 'constant' }, limits: { prefixDeletes: 1 } },
          grow: (_db, scale, previous) => grow(axis, scale, previous, template),
          async warmup(_db, scale) { await prepare(scale); return operation(); },
          prepare: (_db, scale) => prepare(scale), operation,
        });
        assert.deepEqual(report.samples.map((sample) => sample.scale), SCALES);
        for (const sample of report.samples) for (const cost of sample.repetitions) {
          assert(cost.rows > 0 && cost.blocks > 0 && cost.statements > 0);
        }
        const relations = [...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations))))];
        assertGrowthAccessPaths(name, report.samples, relations);
        console.info('Content account erasure growth', JSON.stringify({ name, revision: revision.stdout.trim(), samples: report.samples }));
        reports++;
      }
    }
    return { reports, completed: [...completed], revision: revision.stdout.trim() };
  }
  const reply = (value: unknown) => process.stdout.write(`${PREFIX}${JSON.stringify(value)}\n`);
  reply({ ready: true });
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      try {
        if (message.method === 'stop') { reply({ id: message.id }); break; }
        const value = message.method === 'relay' ? await relayAll() : await measure(message.input);
        reply({ id: message.id, value });
      } catch (error) { reply({ id: message.id, error: error instanceof Error ? error.stack : String(error) }); }
    }
  } finally {
    for (const id of held) {
      const status = await client.getWorkflow(id);
      if (status?.status === 'ENQUEUED' || status?.status === 'PENDING') await client.cancelWorkflow(id);
    }
    try { await runtime.shutdown(); } finally { try { await client.close(); } finally { await db.close(); } }
  }
}

if (process.argv.includes('--erasure-growth-worker')) await worker();
