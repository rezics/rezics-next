import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { execFileSync } from 'node:child_process';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { workRead, WorkReadExpired, WorkReadMissing, type ReadRow } from '../src/modules/work/read-session.ts';
import { readWorkHeader } from '../src/modules/work/read-header.ts';
import { readWorkEditions } from '../src/modules/work/metadata-read.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { resolveInterpretation } from '../src/modules/context/interpretation.ts';
import { CONTEXT_READ_COST, ContextNotFound, contextReadBudget, readContextRevision } from '../src/modules/context/read.ts';
import { ContextCommandUnavailable } from '../src/modules/context/command.ts';
import { CONTEXT_PROFILE, GLOBAL_SEMANTIC_CONTEXT, contextSelectionScopeKey } from '../src/modules/context/schema.ts';
import { prepareComponent } from '../src/modules/work/activate.ts';
import { contextRoutes } from '../src/routes/contexts.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import { DEFAULT_MEDIA_CONTEXT, type AvatarRow } from '../src/modules/media/store.ts';
import { projectName } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { MAIN_RELAY_STREAM_SCOPE, compareRelayPositions } from '../src/modules/outbox/relay-position.ts';
import { OutboxGap, RelayCheckpointConflict, readNextMainOutboxBatch, relayMainOutboxOnce }
  from '../src/modules/outbox/relay.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { DATASET, GRAPHS, iri, lit, RV } from '../src/modules/work/activate.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const work = id(1), main = id(2), revision = id(3);
const term = (value: string, type = 'literal') => ({ type, value });
const result = (rows: ReadRow[]): SparqlResult => ({ results: { bindings: rows } });

class WorkGraph extends FusekiClient {
  sequence = 1;
  collection = revision;
  profile = 'a'.repeat(64);
  erased = false;
  public = true;
  editions = [id(10), id(11)];
  constructor() { super('http://graph.invalid/rezics'); }
  override async commandHealth() {
    return { profiles: { 'work-metadata-v1': this.profile, 'work-metadata-details-v1': 'b'.repeat(64),
      'work-metadata-details-v2': 'c'.repeat(64) } } as never;
  }
  override async query(query: string): Promise<SparqlResult> {
    const control = { epoch: term('epoch'), sequence: term(String(this.sequence)) };
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result(this.erased ? [control] : [{ ...control,
      r: term(work, 'uri'), type: term('work'), work: term(work, 'uri'), head: term(revision, 'uri'),
      public: term(String(this.public)), label: { ...term('Selected title'), 'xml:lang': 'en' } }]);
    if (query.includes('SELECT ?head ?main ?mainHead')) return result(this.erased ? [] : [{
      head: term(revision, 'uri'), main: term(main, 'uri'), mainHead: term(id(4), 'uri'), public: term(String(this.public)) }]);
    if (query.includes('SELECT ?selection ?language')) return result([]);
    if (query.includes('SELECT ?collectionRevision')) return result([{ collectionRevision: term(this.collection, 'uri') }]);
    if (query.includes('SELECT ?edition ?revision ?state')) {
      return result(this.editions.filter(edition => query.includes(`(<${edition}> `)).map(edition => ({
        edition: term(edition, 'uri'), revision: term(id(Number(edition.slice(-2)) + 100), 'uri'),
        state: term(JSON.stringify({ kind: 'edition', id: edition, status: 'active',
          title: { value: 'An edition', language: 'en' }, contentLanguage: 'en', editionStatement: null,
          publisher: null, publicationYear: null, isbn13: null })) })));
    }
    if (query.includes('SELECT ?edition ?revision')) {
      const after = query.match(/FILTER\(STR\(\?edition\) > "([^"]+)"\)/)?.[1];
      const limit = Number(query.match(/LIMIT (\d+)/)?.[1] ?? 21);
      return result(this.editions.filter(edition => !after || edition > after).slice(0, limit).map(edition => ({
        edition: term(edition, 'uri'), revision: term(id(Number(edition.slice(-2)) + 100), 'uri') })));
    }
    if (query.includes('SELECT ?epoch ?sequence')) return result([control]);
    throw new Error(`Unexpected Work query: ${query}`);
  }
}
function workDeps(graph: WorkGraph) {
  const state = { active: true, granted: true };
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    objectDirectory: '.temp/local-read-basis' }, account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
  access: { assertRecoveryOpen: async () => undefined,
    activePrincipalId: async () => state.active ? 'reader' : null, canReadWork: async () => state.granted } } as unknown as MainWorkDependencies;
  return { deps, state };
}

test('Work header and editions survive unrelated writes; insertions and selected profile changes expire continuations', async () => {
  const graph = new WorkGraph(), { deps } = workDeps(graph);
  const request = new Request(`http://main.test/v1/works/${work.slice(-36)}`);
  let attempts = 0;
  const header = await workRead(deps, request, { localBasis: true }, async session => {
    attempts++; const value = await readWorkHeader(session, work); graph.sequence++; return value;
  });
  expect(attempts).toBe(1);
  expect(header.sourcePosition.dependencyToken).toMatch(/^[0-9a-f]{64}$/);
  const first = await workRead(deps, request, { localBasis: true, limit: 1 }, session => readWorkEditions(session, work));
  graph.sequence++;
  const next = await workRead(deps, request, { localBasis: true, limit: 1, cursor: first.nextCursor! },
    session => readWorkEditions(session, work));
  expect(next.items[0]!.id).toBe(id(11));
  graph.editions.push(id(12)); graph.collection = id(200);
  await expect(workRead(deps, request, { localBasis: true, limit: 1, cursor: first.nextCursor! },
    session => readWorkEditions(session, work))).rejects.toBeInstanceOf(WorkReadExpired);
  const current = await workRead(deps, request, { localBasis: true, limit: 1 }, session => readWorkEditions(session, work));
  graph.profile = 'd'.repeat(64);
  await expect(workRead(deps, request, { localBasis: true, limit: 1, cursor: current.nextCursor! },
    session => readWorkEditions(session, work))).rejects.toBeInstanceOf(WorkReadExpired);
});

test('Local Work pages still recheck principal revocation, private grants and erasure', async () => {
  const graph = new WorkGraph(), { deps, state } = workDeps(graph);
  const request = new Request(`http://main.test/v1/works/${work.slice(-36)}`, { headers: { authorization: 'Bearer reader' } });
  await expect(workRead(deps, request, { localBasis: true, actingSubject: id(30) }, async session => {
    const value = await readWorkHeader(session, work); state.active = false; return value;
  })).rejects.toBeInstanceOf(AccountAssertionDenied);
  state.active = true; graph.public = false;
  await expect(workRead(deps, request, { localBasis: true, actingSubject: id(30) }, async session => {
    const value = await readWorkHeader(session, work); state.granted = false; return value;
  })).rejects.toBeInstanceOf(WorkReadMissing);
  graph.public = true; graph.erased = true;
  await expect(workRead(deps, new Request(request.url), { localBasis: true },
    session => readWorkHeader(session, work))).rejects.toBeInstanceOf(WorkReadMissing);
});

test('An author reading a private Work through their Agent keeps its private draft cover; another principal cannot see the cover', async () => {
  const graph = new WorkGraph(); graph.public = false;
  const author = id(30), outsider = id(31), asset = id(32), selection = id(33);
  const { deps } = workDeps(graph);
  deps.account.verify = async request => ({ issuer: 'account', subject: request.headers.get('authorization') === 'Bearer author'
    ? 'author' : 'outsider' }) as never;
  deps.access.canReadWork = async (principal, actor) => principal.subject === 'author' && actor === author;
  const avatar = { target: work, context: DEFAULT_MEDIA_CONTEXT, selection: selection.slice(-36),
    selectionPosition: '1', use: id(34).slice(-36), asset: asset.slice(-36), crop: null,
    representation: id(35).slice(-36), sha256: 'a'.repeat(64), mediaType: 'image/png',
    width: 400, height: 600, byteLength: 1000, disclosure: 'public', moderation: 'none', lifecycle: 'active',
    availability: 'available', clearance: 'cleared' } as AvatarRow;
  deps.media = { store: {
    avatarRows: async () => ({ rows: new Map([[work, avatar]]), generation: { dataEpoch: 'epoch', sequence: '1' } }),
    visibilityFacts: async (references: readonly string[]) => new Map(references.map(reference => [reference,
      { owner: author, disclosure: 'public', pending: false, blocked: false,
        attachments: [{ target: work, context: DEFAULT_MEDIA_CONTEXT }] }])),
  } } as never;
  configureMediaVisibility(deps);
  const read = (bearer: string, actor: string) => workRead(deps, new Request(`http://main.test/v1/works/${work.slice(-36)}`,
    { headers: { authorization: `Bearer ${bearer}` } }), { localBasis: true, actingSubject: actor },
  session => readWorkHeader(session, work));
  expect((await read('author', author)).cover).toMatchObject({ kind: 'image', selection: selection.slice(-36) });
  // Public Asset bytes do not widen the private Work attachment's audience.
  await expect(read('outsider', outsider)).rejects.toBeInstanceOf(WorkReadMissing);
  await expect(read('outsider', author)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('Context interpretation binds fallback, absent higher-priority slots, pinned heads, disclosure and selected shapes', async () => {
  const graph = new FusekiClient('http://context.invalid/rezics');
  let sequence = 1, shape = 'a'.repeat(64), erased = false, disclosed = true, candidates = false;
  let fallbackHead = revision, contextHead = revision, granted = true;
  let change: (() => void) | undefined;
  graph.commandHealth = async () => ({ profiles: { 'context-v1': shape } }) as never;
  graph.query = async query => {
    if (query.includes('SELECT ?epoch ?sequence')) return result([{ epoch: term('epoch'), sequence: term(String(sequence)) }]);
    if (query.includes('SELECT ?head WHERE')) return result([{ head: term(fallbackHead, 'uri') }]);
    if (query.includes('SELECT ?revision ?base')) {
      const rows = erased ? [] : [{ revision: term(revision, 'uri'), context: term(GLOBAL_SEMANTIC_CONTEXT, 'uri'),
        contextHead: term(contextHead, 'uri'), depth: term('0'), disclosure: term(disclosed ? 'https://rezics.com/vocab/Public'
          : 'https://rezics.com/vocab/Private'), entry: term(id(40), 'uri'),
        state: term('https://rezics.com/vocab/Defined'), definition: term(id(41), 'uri') }];
      change?.(); change = undefined; return result(rows);
    }
    throw new Error(`Unexpected Context query: ${query}`);
  };
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, objectDirectory: '.temp/local-context' };
  const request = { object: work, relation: null, explicit: null,
    speaker: { kind: 'personal' as const, privateCandidates: async () => candidates ? [{
      scope_key: contextSelectionScopeKey({ kind: 'object', object: work }), state: 'selected', context: GLOBAL_SEMANTIC_CONTEXT,
      semantic_revision: revision, head_revision: id(44) }] as never : [], canReadPrivate: async () => granted } };
  change = () => { sequence++; };
  expect((await resolveInterpretation(env, request)).state).toBe('resolved');
  change = () => { shape = 'b'.repeat(64); };
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
  change = () => { candidates = true; };
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
  candidates = false; change = () => { disclosed = false; };
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
  disclosed = true; change = () => { fallbackHead = id(45); };
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
  fallbackHead = revision; change = () => { contextHead = id(46); };
  expect((await resolveInterpretation(env, { ...request, explicit: { context: GLOBAL_SEMANTIC_CONTEXT, semanticRevision: revision } })).state)
    .toBe('unavailable');
  contextHead = revision; disclosed = false; change = () => { granted = false; };
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
  disclosed = true; change = () => { erased = true; };
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
});

test('Context interpretation accepts eight pinned inheritance edges and refuses overflow, cycles and missing bases', async () => {
  const graph = new FusekiClient('http://context.invalid/rezics');
  let depth = 8, calls = 0, cycle = false, missing = false;
  const root = id(500);
  graph.commandHealth = async () => ({ profiles: { 'context-v1': 'a'.repeat(64) } }) as never;
  graph.query = async query => {
    calls++;
    if (query.includes('SELECT ?epoch ?sequence')) return result([{ epoch: term('epoch'), sequence: term('1') }]);
    const pinned = query.match(/BIND\(<([^>]+)> AS \?revision\)/)?.[1];
    const hop = Number(pinned?.slice(-3)) - 500;
    if (!pinned || missing && hop === 1) return result([]);
    return result([{ revision: term(pinned, 'uri'), context: term(GLOBAL_SEMANTIC_CONTEXT, 'uri'),
      contextHead: term(root, 'uri'), disclosure: term(`${RV}Public`, 'uri'), depth: term(String(depth - hop)),
      ...(hop < depth ? { base: term(cycle ? root : id(501 + hop), 'uri') } : {}) }]);
  };
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, objectDirectory: '.temp/local-context' };
  const request = { object: work, relation: null, explicit: { context: GLOBAL_SEMANTIC_CONTEXT, semanticRevision: root },
    speaker: { kind: 'personal' as const } };
  expect((await resolveInterpretation(env, request)).state).toBe('resolved');
  expect(calls).toBe(20);
  calls = 0; depth = 9;
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
  expect(calls).toBe(10);
  depth = 8; cycle = true;
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
  cycle = false; missing = true;
  expect((await resolveInterpretation(env, request)).state).toBe('unavailable');
});

test('Context revision ignores unrelated sequence changes and refuses changed profiles and revoked private reads', async () => {
  const directory = resolve('.temp', `context-read-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const graph = new FusekiClient('http://context.invalid/rezics');
  const context = id(50);
  let sequence = 1, shape = 'a'.repeat(64), isPrivate = false;
  const manifest = prepareComponent(directory, context, { revision, inheritanceDepth: 0, entries: [], authoredBy: id(51) }, CONTEXT_PROFILE);
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, objectDirectory: directory };
  graph.commandHealth = async () => ({ profiles: { 'context-v1': shape } }) as never;
  graph.query = async query => {
    if (!query.includes('?manifest')) return { boolean: true };
    const rows = [{ epoch: term('epoch'), sequence: term(String(sequence++)), role: term('https://rezics.com/vocab/SharedInterpretation'),
      state: term('https://rezics.com/vocab/Active'), disclosure: term(`https://rezics.com/vocab/${isPrivate ? 'Private' : 'Public'}`),
      head: term(revision, 'uri'), revision: term(revision, 'uri'), manifest: term(`urn:rezics:sha256:${manifest}`, 'uri') }];
    return result(rows);
  };
  try {
    expect((await readContextRevision(env, context, null, async () => false)).revision).toBe(revision);
    const query = graph.query.bind(graph);
    graph.query = async text => { const rows = await query(text); if (text.includes('?manifest')) shape = 'b'.repeat(64); return rows; };
    await expect(readContextRevision(env, context, null, async () => true)).rejects.toBeInstanceOf(ContextCommandUnavailable);
    graph.query = query; isPrivate = true;
    let checks = 0;
    await expect(readContextRevision(env, context, null, async () => ++checks === 1)).rejects.toBeInstanceOf(ContextNotFound);
    isPrivate = false;
    let active = true, anchors = 0;
    graph.query = async text => {
      const rows = await query(text);
      if (text.includes('?manifest') && ++anchors === 2) active = false;
      return rows;
    };
    const deps = { environment: env, account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
      access: { activePrincipalId: async () => active ? 'reader' : null } } as unknown as MainWorkDependencies;
    const response = await contextRoutes(graph, deps).handle(new Request(
      `http://main.test/v1/contexts/${context.slice(-36)}?actingSubject=${id(51)}`,
      { headers: { authorization: 'Bearer reader' } }));
    expect(response.status).toBe(401);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Relay compares positions only inside one stream; its watermark is independent and missing batches fail closed', async () => {
  const position = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '1' };
  expect(compareRelayPositions(position, { ...position, sequence: '2' })).toBe(-1);
  expect(() => compareRelayPositions(position, { ...position, streamScope: 'urn:rezics:stream:another' })).toThrow('different streams');
  const graph = new FusekiClient('http://relay.invalid/rezics');
  graph.query = async query => {
    expect(query).toContain('rv:streamSequence ?controlSequence');
    expect(query).not.toContain('rv:sequence ?controlSequence');
    return result([{ controlSequence: term('1'), routing: term('1') }]);
  };
  expect(await readNextMainOutboxBatch(graph, 'epoch', '1')).toBeNull();
  await expect(readNextMainOutboxBatch(graph, 'epoch', '0')).rejects.toBeInstanceOf(OutboxGap);
  const pool = { query: async () => ({ rows: [{ stream_scope: 'urn:rezics:stream:another', data_epoch: 'epoch', sequence: '1' }] }) } as unknown as Pool;
  await expect(relayMainOutboxOnce(graph, pool, 'consumer')).rejects.toBeInstanceOf(RelayCheckpointConflict);
});

test('Context local dependency passes debit an actual bounded HTTP call budget', async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    calls++; return Response.json({ results: { bindings: [] } });
  } });
  const graph = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
  try {
    await expect(contextReadBudget(async () => {
      for (let index = 0; index <= CONTEXT_READ_COST.graphCalls; index++) await graph.query('SELECT ?x WHERE {}');
    })).rejects.toBeInstanceOf(ContextCommandUnavailable);
    expect(calls).toBe(CONTEXT_READ_COST.graphCalls);
  } finally { await server.stop(true); }
});

test('Relay zero-event handoff replays a crash after delivery and advances one scoped checkpoint', async () => {
  const graph = new FusekiClient('http://relay.invalid/rezics');
  graph.query = async query => query.includes('SELECT ?controlSequence')
    ? result([{ controlSequence: term('1'), routing: term('1'), batch: term('urn:rezics:batch:one', 'uri'),
      eventCount: term('0'), graphSequence: term('900') }]) : result([]);
  let checkpoint = '0', retained = false;
  const pool = { query: async (query: string) => {
    if (query.startsWith('SELECT stream_scope')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
      data_epoch: 'epoch', sequence: checkpoint }] };
    if (query.includes('INSERT INTO relay.delivered_batch')) {
      const rowCount = retained ? 0 : 1; retained = true; return { rows: [], rowCount };
    }
    if (query.includes('SELECT batch_id')) return { rows: [{ same: true }] };
    if (query.includes('UPDATE relay.checkpoint')) {
      expect(query).toContain('stream_scope'); checkpoint = '1'; return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected relay SQL: ${query}`);
  } } as unknown as Pool;
  await expect(relayMainOutboxOnce(graph, pool, 'consumer', { afterDelivery: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  expect(checkpoint).toBe('0');
  expect((await relayMainOutboxOnce(graph, pool, 'consumer'))?.sequence).toBe('1');
  expect(checkpoint).toBe('1');
});

test.skipIf(!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL)('Local read basis: populated relay upgrade, independent native stream, durable crash replay, zero-event progress and missing batch', async () => {
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const client = await pool.connect();
  const schema = `relay_upgrade_${crypto.randomUUID().replaceAll('-', '')}`;
  let upgradeError: unknown = null;
  try {
    await client.query('BEGIN');
    for (const migration of ['001_delivery.sql', '003_retained_batches.sql']) {
      await client.query(readFileSync(resolve('services/main/migrations/relay', migration), 'utf8').replace(/\brelay\b/g, schema));
    }
    await client.query(`INSERT INTO ${schema}.checkpoint (consumer, data_epoch, sequence) VALUES ('legacy', 'epoch', 2)`);
    await client.query(`INSERT INTO ${schema}.delivered_batch (data_epoch, sequence, batch_id, routing_epoch, event_count)
      VALUES ('epoch', 1, 'zero', '1', 0), ('epoch', 2, 'event-batch', '1', 1)`);
    const envelope = { data: { sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '2' } } };
    await client.query(`INSERT INTO ${schema}.delivered_event (source, event_id, data_epoch, sequence, envelope)
      VALUES ('main', 'event', 'epoch', 2, $1::jsonb)`, [JSON.stringify(envelope)]);
    await client.query(readFileSync(resolve('services/main/migrations/relay/020_main_stream_scope.sql'), 'utf8').replace(/\brelay\b/g, schema));
    expect((await client.query(`SELECT stream_scope, sequence::text FROM ${schema}.checkpoint`)).rows)
      .toEqual([{ stream_scope: MAIN_RELAY_STREAM_SCOPE, sequence: '2' }]);
    expect((await client.query(`SELECT sequence::text, event_count FROM ${schema}.delivered_batch ORDER BY sequence`)).rows)
      .toEqual([{ sequence: '1', event_count: 0 }, { sequence: '2', event_count: 1 }]);
    expect((await client.query(`SELECT envelope FROM ${schema}.delivered_event`)).rows[0].envelope)
      .toEqual(envelope);
    await client.query(`INSERT INTO ${schema}.delivered_batch (stream_scope, data_epoch, sequence, batch_id, routing_epoch, event_count)
      VALUES ('another-stream', 'epoch', 2, 'another-batch', '1', 0)`);
    expect((await client.query(`SELECT count(*)::integer AS count FROM ${schema}.delivered_batch WHERE sequence = 2`)).rows[0].count).toBe(2);
  } catch (error) { upgradeError = error; }
  finally { await client.query('ROLLBACK'); client.release(); }
  if (upgradeError !== null) { await pool.end(); throw upgradeError; }
  const stack = await startMediaStack('local-read-basis').catch(async error => { await pool.end(); throw error; });
  try {
    const actor = await stack.member('relay-reader');
    await stack.privateWork(actor.actor, 'Legacy source fixture');
    await stack.privateWork(actor.actor, 'Second retained legacy batch');
    const control = async () => {
      const row = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?graphSequence ?streamSequence WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?graphSequence .
          ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ?streamSequence } }`)).results!.bindings[0]!;
      return { epoch: row.epoch!.value, graph: row.graphSequence!.value, stream: row.streamSequence!.value };
    };
    const legacy = await control();
    await pool.query(`INSERT INTO relay.checkpoint (consumer, stream_scope, data_epoch, sequence)
      VALUES ('upgrade-restart', $1, $2, $3)`, [MAIN_RELAY_STREAM_SCOPE, legacy.epoch, (BigInt(legacy.stream) - 2n).toString()]);
    const retained = await relayMainOutboxOnce(stack.fuseki, pool, 'upgrade-restart');
    expect(retained?.sequence).toBe((BigInt(legacy.stream) - 1n).toString());
    await pool.query("UPDATE relay.delivered_event SET envelope = envelope #- '{data,relayPosition}' WHERE data_epoch=$1 AND sequence=$2",
      [legacy.epoch, retained!.sequence]);
    const retainedBytes = (await pool.query('SELECT envelope::text AS body FROM relay.delivered_event WHERE data_epoch=$1 AND sequence=$2',
      [legacy.epoch, retained!.sequence])).rows[0]!.body;
    const restart = async () => {
      const previous = (await stack.fuseki.commandHealth()).instanceId;
      const dockerEnv = loadDockerEnvironment();
      const project = projectName({ profile: 'qa', runId: Bun.env.REZICS_QA_RUN_ID! });
      const container = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
        '--filter', 'label=com.docker.compose.service=fuseki'], { env: dockerEnv, encoding: 'utf8', timeout: 10_000 }).trim();
      if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Disposable QA Fuseki container is unavailable or ambiguous');
      execFileSync('docker', ['restart', '--time', '30', container], { env: dockerEnv, timeout: 60_000, stdio: 'pipe' });
      for (let attempt = 0; attempt < 120; attempt++) {
        try { if ((await stack.fuseki.commandHealth()).instanceId !== previous) return; } catch { /* restarting */ }
        await Bun.sleep(250);
      }
      throw new Error('Disposable QA Fuseki did not restart');
    };
    // A populated pre-upgrade source and SQL checkpoint: service restart is
    // the only transition before the relay resumes its retained legacy prefix.
    await stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} ?p ?value }
        GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:streamScope ?scope ; rv:streamSequence ?sequence } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} ?p ?value }
        GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:dataEpoch ${lit(legacy.epoch)} ;
          rv:streamScope ?scope ; rv:streamSequence ?sequence } }`);
    await restart();
    expect((await control()).stream).toBe(legacy.stream);
    const legacyBatch = await readNextMainOutboxBatch(stack.fuseki, legacy.epoch, (BigInt(legacy.stream) - 1n).toString());
    expect(legacyBatch?.streamScope).toBe(MAIN_RELAY_STREAM_SCOPE);
    expect(legacyBatch?.sequence).toBe(legacy.stream);
    await expect(relayMainOutboxOnce(stack.fuseki, pool, 'upgrade-restart', {
      afterDelivery: async () => { throw new Error('crash during legacy upgrade'); },
    })).rejects.toThrow('crash during legacy upgrade');
    await restart();
    expect((await relayMainOutboxOnce(stack.fuseki, pool, 'upgrade-restart'))?.sequence).toBe(legacy.stream);
    await stack.privateWork(actor.actor, 'First scoped batch after restart');
    const scoped = await relayMainOutboxOnce(stack.fuseki, pool, 'upgrade-restart');
    expect(scoped?.sequence).toBe((BigInt(legacy.stream) + 1n).toString());
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.outbox)} {
      ${iri(scoped!.batchId)} rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)} ; rv:streamSequence ${scoped!.sequence} } }`)).boolean).toBeTrue();
    expect((await pool.query('SELECT sequence::text FROM relay.delivered_batch WHERE data_epoch=$1 ORDER BY sequence', [legacy.epoch])).rows)
      .toEqual([retained!.sequence, legacy.stream, scoped!.sequence].map(sequence => ({ sequence })));
    expect((await pool.query('SELECT count(*)::integer AS count FROM relay.delivered_event WHERE data_epoch=$1', [legacy.epoch])).rows[0]!.count)
      .toBe(3);
    expect((await pool.query('SELECT envelope::text AS body FROM relay.delivered_event WHERE data_epoch=$1 AND sequence=$2',
      [legacy.epoch, retained!.sequence])).rows[0]!.body).toBe(retainedBytes);
    expect(await relayMainOutboxOnce(stack.fuseki, pool, 'upgrade-restart')).toBeNull();
    const before = await control();
    await pool.query(`INSERT INTO relay.checkpoint (consumer, stream_scope, data_epoch, sequence)
      VALUES ('local-handoff', $1, $2, $3)`, [MAIN_RELAY_STREAM_SCOPE, before.epoch, before.stream]);
    // Maintenance-only fixture: graph diagnostic movement does not create a relay batch.
    const diagnostic = (BigInt(before.graph) + 1000n).toString();
    await stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${before.graph} } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${diagnostic} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${before.graph} } }`);
    expect(await relayMainOutboxOnce(stack.fuseki, pool, 'local-handoff')).toBeNull();
    await stack.privateWork(actor.actor, 'Independent stream receipt');
    await expect(relayMainOutboxOnce(stack.fuseki, pool, 'local-handoff', {
      afterDelivery: async () => { throw new Error('crash after durable event'); },
    })).rejects.toThrow('crash after durable event');
    const batch = await relayMainOutboxOnce(stack.fuseki, pool, 'local-handoff');
    expect(batch?.sequence).toBe((BigInt(before.stream) + 1n).toString());
    expect(batch?.graphSequence).toBe((BigInt(diagnostic) + 1n).toString());
    const events = await pool.query(`SELECT envelope FROM relay.delivered_event WHERE stream_scope = $1 AND data_epoch = $2 AND sequence = $3`,
      [MAIN_RELAY_STREAM_SCOPE, before.epoch, batch!.sequence]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].envelope.data.relayPosition).toMatchObject({ streamScope: MAIN_RELAY_STREAM_SCOPE,
      sequence: batch!.sequence });
    expect(events.rows[0].envelope.data.sourcePosition.sequence).toBe(batch!.graphSequence);
    const next = (BigInt(batch!.sequence) + 1n).toString();
    const empty = `urn:rezics:outbox:${crypto.randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ${batch!.sequence} } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ${next} }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(empty)} a rv:OutboxBatch ; rv:dataEpoch ${lit(before.epoch)} ;
          rv:sequence ${batch!.graphSequence} ; rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)} ;
          rv:streamSequence ${next} ; rv:eventCount 0 } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ${batch!.sequence} } }`);
    expect((await relayMainOutboxOnce(stack.fuseki, pool, 'local-handoff'))?.eventIds).toEqual([]);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ${next} } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ${BigInt(next) + 1n} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ${next} } }`);
    await expect(relayMainOutboxOnce(stack.fuseki, pool, 'local-handoff')).rejects.toBeInstanceOf(OutboxGap);
  } finally { await stack.stop(); await pool.end(); }
}, 120_000);
