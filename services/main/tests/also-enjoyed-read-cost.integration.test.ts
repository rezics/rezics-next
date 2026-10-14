import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { createMainApp } from '../src/app.ts';
import { AlsoEnjoyedStore } from '../src/modules/also-enjoyed/store.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../src/modules/recommendation/derived-generation.ts';
import { GRAPHS, iri, RV } from '../src/modules/work/activate.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import { compatibleLoadStorage, loadCompatibility, type LoadCompatibility } from '../../../scripts/load/compatibility.ts';
import { dockerEnvironment, stream } from '../../../scripts/fixture/stack.ts';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';
import { attributeSqlCheckoutCallers } from '../../../tests/qa/integration/support/query-cost-meter.ts';

const directory = resolve('.temp/also-enjoyed-read-cost');
const scales = [8, 16, 32];
const recipe = 'https://schema.org/Recipe', book = 'https://schema.org/Book';
type Stack = Awaited<ReturnType<typeof startMediaStack>>;
type Work = Pick<Awaited<ReturnType<Stack['publicWork']>>, 'work' | 'mainVersion' | 'title'>;
type Person = { name: string; actor: string; visibilityVersion: number };
type Cut = { scale: number; backup: string; works: Work[]; generation: string; headRevision: string; preparationMs: number };
type Seed = { sourceRunId: string; compatibility: LoadCompatibility; source: Work; candidates: Work[]; concealed: Work;
  owner: Person; member: Person; readers: Person[]; unrelatedReaders: Person[]; cuts: Cut[] };
type Call = { kind: 'graph' | 'sql' | 'native'; query: string; ms: number; rows?: number; examined?: number;
  values?: unknown[]; indexed?: boolean; failure?: string };
type Plan = { 'Node Type': string; 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number; 'Heap Fetches'?: number; Plans?: Plan[] };
type Answer = { scale: number; persona: string; phase: string; status: number; body: string; ms: number;
  headroomMs: number; calls: Call[]; before: unknown; after: unknown; hostLoad: string; plans?: { sql: string; plan: Plan }[] };
type Page = { items: { id: string; basis: string }[]; nextCursor: string | null; stale: boolean };
const context = new AsyncLocalStorage<Call[]>();

async function json<T>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function open() {
  const stack = await startMediaStack('also-enjoyed-cost', { library: true });
  stack.access.configureBaseline(stack.fuseki);
  const members = new Map<string, Awaited<ReturnType<Stack['member']>>>();
  const principals = new Map<string, Awaited<ReturnType<Stack['member']>>['principal']>();
  const store = new AlsoEnjoyedStore(stack.accessPool, stack.contentPool);
  const account = { verify: async (request: Request) => {
    const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
    if (!principal) throw new Error('Unknown QA bearer');
    const verified = { ...principal, emailVerified: true as const };
    return { ...verified, currentAssertion: async () => verified };
  } };
  const app = createMainApp(stack.fuseki, { ...stack.composition.dependencies, account, alsoEnjoyed: store });
  const member = async (name: string) => {
    if (!members.has(name)) {
      const value = await stack.member(`also-enjoyed-cost-${name}`, { stable: true, verified: true });
      members.set(name, value); principals.set(value.token, value.principal);
    }
    return members.get(name)!;
  };
  const send = async (name: string, method: string, path: string, body?: unknown) =>
    app.handle(new Request(`http://main.local${path}`, { method, headers: {
      authorization: `Bearer ${(await member(name)).token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID(),
    }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const person = async (name: string): Promise<Person> => {
    const value = await json<{ agent: string }>(await send(name, 'POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: name,
    }), 201);
    const state = await json<{ version: number }>(await send(name, 'PUT',
      `/v1/agents/${value.agent.slice(-36)}/library-visibility`, { visibility: 'public', expectedVersion: 0 }));
    return { name, actor: value.agent, visibilityVersion: state.version };
  };
  const grant = async (person: Person, scope: string, action: string) => {
    const principal = await member(person.name), client = await stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      await grantFixtureAuthority(client, { scope, requireDispatch: true,
        representations: [{ principalId: principal.principalId, actor: person.actor, action, lifetime: '8 hours' }],
        grant: { actor: person.actor, action, lifetime: '8 hours' } });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const type = async (owner: Person, work: Work, semanticType: string) => {
    const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    await grant(owner, `work:edit:${work.work}`, 'work.edit');
    await json(await send(owner.name, 'PUT', `/v1/works/${work.work.slice(-36)}/type`, {
      profile: 'work-type-v2', expectedHead: head, types: [semanticType], actingSubject: owner.actor,
    }));
  };
  const typed = async (owner: Person, title: string, semanticType: string) => {
    const work = await stack.publicWork(owner.actor, ['en'], title);
    await type(owner, work, semanticType); return work;
  };
  const shelve = async (reader: Person, work: Work, status: 'read' | 'reading', expectedVersion = 0) =>
    json(await send(reader.name, 'PUT', `/v1/works/${work.work.slice(-36)}/reader-status`, {
      actingSubject: reader.actor, expectedVersion, status,
    }));
  const build = async (owner: Person, headRevision: string | null) => {
    const { generation } = await json<{ generation: string }>(await send(owner.name, 'POST',
      '/v1/also-enjoyed/generation-builds', { actingSubject: owner.actor }));
    let advances = 0;
    while ((await store.generation(generation)).phase !== 'complete') {
      await json(await send(owner.name, 'POST', `/v1/also-enjoyed/generations/${generation}/advance`, { actingSubject: owner.actor }));
      if (++advances > 64) throw new Error('Seed generation exceeded its bounded writer batches');
    }
    return json<{ generation: string; headRevision: string }>(await send(owner.name, 'POST', '/v1/also-enjoyed/generation-activations', {
      actingSubject: owner.actor, generation, expectedHeadRevision: headRevision,
    }));
  };
  const query = stack.fuseki.query.bind(stack.fuseki);
  stack.fuseki.query = async (...args) => {
    const calls = context.getStore();
    if (!calls || !foregroundCounted()) return query(...args);
    const call: Call = { kind: 'graph', query: args[0], ms: 0 }, started = performance.now(); calls.push(call);
    try { const value = await query(...args); call.rows = value.results?.bindings.length; return value; }
    catch (error) { call.failure = String(error); throw error; }
    finally { call.ms = performance.now() - started; }
  };
  // The before cut can use the old reader/store against these same retained
  // primary-data checkpoints. Missing native calls then remain explicit.
  const native = stack.fuseki.alsoEnjoyedCandidates?.bind(stack.fuseki);
  if (native) stack.fuseki.alsoEnjoyedCandidates = async input => {
    const calls = context.getStore();
    if (!calls || !foregroundCounted()) return native(input);
    const call: Call = { kind: 'native', query: JSON.stringify(input), ms: 0 }, started = performance.now(); calls.push(call);
    try { const value = await native(input); call.examined = value.examined; call.rows = value.works.length; return value; }
    catch (error) { call.failure = String(error); throw error; }
    finally { call.ms = performance.now() - started; }
  };
  return { stack, app, store, member, send, person, grant, type, typed, shelve, build, stop: () => stack.stop() };
}
type Owner = Awaited<ReturnType<typeof open>>;

async function revisions(owner: Owner) {
  return {
    access: (await owner.stack.accessPool.query(`SELECT revision::text,privacy_revision::text,
      (SELECT count(*)::integer FROM access.also_enjoyed_source_change) AS pending,
      (SELECT count(*)::integer FROM access.also_enjoyed_source_change WHERE privacy) AS private_pending
      FROM access.also_enjoyed_source_fence WHERE id`)).rows,
    content: (await owner.stack.contentPool.query(`SELECT revision::text,privacy_revision::text,
      (SELECT count(*)::integer FROM reader.also_enjoyed_source_change) AS pending,
      (SELECT count(*)::integer FROM reader.also_enjoyed_source_change WHERE privacy) AS private_pending
      FROM reader.also_enjoyed_source_fence WHERE id`)).rows,
    served: (await owner.stack.accessPool.query(`SELECT a.generation_id,a.graph_epoch,a.graph_sequence::text,
      a.access_revision::text,a.content_revision::text FROM access.derived_generation_head h
      JOIN access.also_enjoyed_generation a ON a.generation_id=h.active_generation WHERE h.family='also-enjoyed'`)).rows,
  };
}
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
async function plans(owner: Owner, answer: Answer) {
  const result: { sql: string; plan: Plan }[] = [];
  for (const call of answer.calls.filter(call => call.kind === 'sql' && /^\s*SELECT\b/i.test(call.query)
    && /also_enjoyed_(source|signal|pair|generation)/.test(call.query))) {
    const pool: Pool = call.query.includes('reader.also_enjoyed') ? owner.stack.contentPool : owner.stack.accessPool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (call.indexed) await client.query('SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off');
      const value = await client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${call.query}`, call.values);
      result.push({ sql: call.query, plan: value.rows[0]!['QUERY PLAN'][0]!.Plan });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  return result;
}

test('also-enjoyed first answers and underlying work stay bounded across retained 8/16/32 source cuts', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the registered integration tier');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const seedPath = join(directory, 'seed.json'), evidencePath = join(directory, `answers-${runId}.json`);
  let source: Owner | undefined, copy: Owner | undefined, seed: Seed | undefined, finalCut = false;
  const answers: Answer[] = [], targets = new Set<string>();
  const save = () => writeFileSync(evidencePath, JSON.stringify({ runId, seed, answers,
    graphEvidence: 'Native examined counts are actual trie rows; plain SPARQL output rows are not internal tuple visits.' }, null, 2));
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const sql = prototype.query, indexed = new WeakMap<object, boolean>();
  const restoreCheckout = attributeSqlCheckoutCallers();
  prototype.query = function (this: object, ...args: unknown[]) {
    const query = typeof args[0] === 'string' ? args[0] : '';
    if (query.includes('SET LOCAL enable_seqscan = off')) indexed.set(this, true);
    const calls = context.getStore();
    const isIndexed = indexed.get(this) === true;
    if (/^(COMMIT|ROLLBACK)/.test(query)) indexed.delete(this);
    if (!calls || !foregroundCounted()) return sql.apply(this, args);
    const call: Call = { kind: 'sql', query, values: Array.isArray(args[1]) ? args[1] : undefined,
      indexed: isIndexed, ms: 0 }, started = performance.now(); calls.push(call);
    const completed = (value: { rows?: unknown[] }) => {
      call.ms = performance.now() - started; call.rows = value.rows?.length; return value;
    };
    const failed = (error: unknown) => { call.ms = performance.now() - started; call.failure = String(error); };
    const callbackIndex = args.length - 1, callback = args[callbackIndex];
    if (typeof callback === 'function') {
      args[callbackIndex] = function (this: unknown, error: unknown, value: { rows?: unknown[] }) {
        if (error) failed(error); else completed(value);
        return callback.call(this, error, value);
      };
      return sql.apply(this, args);
    }
    try {
      const result = sql.apply(this, args);
      if (!(result instanceof Promise)) return result;
      return result.then(completed, (error: unknown) => { failed(error); throw error; });
    } catch (error) { failed(error); throw error; }
  };
  const backup = createCorpusBackupDriver({ sourceRunId: runId, directory: join(directory, 'backups'),
    get resumeSource() { return !finalCut; }, restoreResourceClass: 'ordinary',
    quiesce: async () => { await source!.stop(); source = undefined; return async () => { source = await open(); }; },
    smokeRead: async input => {
      const environment = { ...input.apps, REZICS_QA_RUN_ID: input.runId, REZICS_QA_STACK_MODE: 'scale' };
      const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
      Object.assign(process.env, environment);
      try { copy = await open(); }
      finally { for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      } }
      return async () => { await copy!.stop(); copy = undefined; };
    },
  });
  const read = async (owner: Owner, persona: string, scale: number, phase: string,
    work = seed!.source, limit = 12, cursor?: string, acting?: string) => {
    const person = persona === 'owner' ? seed!.owner : seed!.member;
    const url = new URL(`http://main.local/v1/works/${work.work.slice(-36)}/also-enjoyed?limit=${limit}&language=en`);
    const headers = new Headers();
    if (persona !== 'stranger') { url.searchParams.set('actingSubject', acting ?? person.actor);
      headers.set('authorization', `Bearer ${(await owner.member(person.name)).token}`); }
    if (cursor) url.searchParams.set('cursor', cursor);
    const before = await revisions(owner), calls: Call[] = [], hostLoad = readFileSync('/proc/loadavg', 'utf8').trim();
    const started = performance.now();
    const response = await context.run(calls, () => owner.app.handle(new Request(url, { headers })));
    const body = await response.text(), ms = performance.now() - started;
    const answer: Answer = { scale, persona, phase, status: response.status, body, ms,
      headroomMs: 2_000 - ms, before, after: await revisions(owner), calls, hostLoad };
    answers.push(answer); save(); return answer;
  };
  try {
    try {
      const retained = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed;
      if (retained.cuts.length === 3 && compatibleLoadStorage(retained.compatibility, loadCompatibility(resolve('.')))) seed = retained;
    } catch { /* Only a complete compatible seed is reusable. */ }
    if (!seed) {
      const started = performance.now(); source = await open();
      const owner = await source.person('owner'), member = await source.person('member');
      const work = await source.typed(owner, 'Fixed source recipe', recipe), candidates: Work[] = [];
      for (let index = 0; index < 3; index++) candidates.push(await source.typed(owner, `Fixed candidate recipe ${index}`, recipe));
      const concealed = await source.stack.privateWork(owner.actor, 'Concealed source recipe');
      await source.type(owner, concealed, recipe); await source.grant(owner, `work:read:${concealed.work}`, 'work.read');
      seed = { sourceRunId: runId, compatibility: loadCompatibility(resolve('.')), source: work, candidates, concealed,
        owner, member, readers: [], unrelatedReaders: [], cuts: [] };
      // Keep provisioned identities fixed. Additional participating readers are
      // the 8/16/32 who acquire an unrelated Work shelf signal in each cut.
      for (let index = 0; index < 4; index++) seed.readers.push(await source.person(`local-reader-${index}`));
      for (let index = 0; index < 32; index++) seed.unrelatedReaders.push(await source.person(`unrelated-reader-${index}`));
      for (const persona of ['owner', 'member', 'stranger']) await read(source, persona, 0, 'first-owner-regression');
      for (const reader of seed.readers) for (const item of [work, ...candidates]) await source.shelve(reader, item, 'read');
      await source.grant(owner, MANAGE_SCOPE, MANAGE_ACTION);
      const works: Work[] = []; let head: string | null = null;
      for (const scale of scales) {
        while (works.length < scale) {
          const index = works.length;
          const unrelated = await source!.typed(owner, `Unrelated book ${index}`, book);
          await source!.shelve(seed.unrelatedReaders[index]!, unrelated, 'read'); works.push(unrelated);
        }
        const generation = await source!.build(owner, head); head = generation.headRevision;
        finalCut = scale === 32;
        const checkpoint = await backup.backup(`unrelated-${scale}`, AbortSignal.timeout(600_000));
        seed.cuts.push({ scale, backup: checkpoint, works: [...works], generation: generation.generation,
          headRevision: generation.headRevision, preparationMs: performance.now() - started });
        writeFileSync(seedPath, JSON.stringify(seed, null, 2)); save();
        expect(performance.now() - started).toBeLessThan(600_000);
      }
    } else {
      // Release the unused harness stack before restoring retained copies.
      await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', runId, '--persistent'], dockerEnvironment());
    }
    for (const cut of seed.cuts) {
      const target = `also-enjoyed-${runId}-${cut.scale}`; targets.add(target);
      await backup.restore(cut.backup, target, AbortSignal.timeout(600_000));
      try {
        expect(backup.preparation(target)!.totalMs).toBeLessThan(600_000);
        const active = copy!;
        // These ordinary supported source changes are deliberately pending.
        // No folding, generation advancement or warming precedes any GET.
        for (let index = 0; index < cut.scale; index++)
          await active.shelve(seed.unrelatedReaders[index]!, cut.works[index]!, 'reading', 1);
        for (const phase of ['first-after-source-changes', 'ordinary']) for (const persona of ['owner', 'member', 'stranger']) {
          const answer = await read(active, persona, cut.scale, phase);
          answer.plans = await plans(active, answer); save();
        }
        const cursor = await read(active, 'owner', cut.scale, 'cursor-basis', seed.source, 1);
        if (cursor.status === 200) {
          const prior = (JSON.parse(cursor.body) as Page).nextCursor;
          if (prior) {
            await read(active, 'member', cut.scale, 'wrong-subject-cursor', seed.source, 1, prior);
            await active.build(seed.owner, cut.headRevision);
            await read(active, 'owner', cut.scale, 'stale-generation-cursor', seed.source, 1, prior);
          }
        }
        await json(await active.send(seed.readers[0]!.name, 'PUT', `/v1/agents/${seed.readers[0]!.actor.slice(-36)}/library-visibility`, {
          visibility: 'private', expectedVersion: seed.readers[0]!.visibilityVersion,
        }));
        await read(active, 'stranger', cut.scale, 'privacy-withdrawal');
        await read(active, 'stranger', cut.scale, 'concealed-source', seed.concealed);
        await read(active, 'owner', cut.scale, 'wrong-subject', seed.concealed, 12, undefined, seed.member.actor);
      } finally { await backup.stop(target); targets.delete(target); }
    }
    // Keep the entire first/refusal cut before assertions, with no caller retries.
    for (const answer of answers) {
      if (['concealed-source', 'wrong-subject'].includes(answer.phase)) { expect(answer.status, answer.body).toBe(404); continue; }
      if (answer.phase === 'wrong-subject-cursor') { expect(answer.status, answer.body).toBe(400); continue; }
      if (answer.phase === 'stale-generation-cursor') { expect(answer.status, answer.body).toBe(409); continue; }
      expect(answer.status, `${answer.scale}/${answer.persona}/${answer.phase}: ${answer.body}`).toBe(200);
      const page = JSON.parse(answer.body) as Page;
      if (answer.phase === 'cursor-basis') { expect(page.nextCursor).not.toBeNull(); continue; }
      expect(page.items.map(item => item.id).sort()).toEqual(seed.candidates.map(item => item.work).sort());
      const basis = ['first-owner-regression', 'privacy-withdrawal'].includes(answer.phase) ? 'similar' : 'co-readers';
      expect(page.items.every(item => item.basis === basis)).toBe(true);
      expect(answer.ms, `${answer.scale}/${answer.persona}/${answer.phase}`).toBeLessThan(2_000);
      expect(answer.calls.some(call => /fold_also_enjoyed|INSERT INTO access.also_enjoyed|UPDATE access.also_enjoyed/.test(call.query))).toBe(false);
      if (answer.plans) {
        for (const measured of answer.plans) {
          const scanned = nodes(measured.plan);
          expect(scanned.some(node => ['Seq Scan', 'Bitmap Heap Scan', 'Bitmap Index Scan'].includes(node['Node Type'])), measured.sql).toBe(false);
          if (measured.sql.includes('source_eligible')) expect(Math.max(...scanned.map(node => node['Actual Rows']))).toBeLessThanOrEqual(4);
        }
      }
    }
    for (const persona of ['owner', 'member', 'stranger']) {
      const measured = answers.filter(answer => answer.persona === persona && answer.phase === 'first-after-source-changes');
      expect(measured.map(answer => answer.scale)).toEqual(scales);
      const nativeRows = measured.map(answer => answer.calls.filter(call => call.kind === 'native')
        .reduce((sum, call) => sum + (call.examined ?? 0), 0));
      expect(nativeRows[0]).toBeGreaterThan(0);
      expect(new Set(nativeRows).size).toBe(1);
      const sqlRows = measured.map(answer => answer.plans!.reduce((sum, measuredPlan) => sum + nodes(measuredPlan.plan)
        .reduce((count, node) => count + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)
          + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'], 0), 0));
      expect(new Set(sqlRows).size).toBe(1);
    }
  } finally {
    for (const target of targets) await backup.stop(target);
    await source?.stop(); prototype.query = sql; restoreCheckout(); save();
    console.log(`Also-enjoyed first-answer/growth evidence: ${evidencePath}`);
  }
}, 480_000);
