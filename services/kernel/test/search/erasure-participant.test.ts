import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { acknowledgeErasure, readErasureStatus } from '../../src/access/erasure.ts';
import { createPool } from '../../src/database/pool.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { SubjectDocument } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createPersonas, type Persona, type PersonasOptions } from '../support/personas.ts';
import { testKernel, testRouteKey, testTokens, type TestKernel } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createOutcomeRpc } from './support/outcome-rpc.ts';

const tombstone = 'com.rezics.access.account-tombstoned.v1';
const pool = createPool(process.env.DATABASE_URL!);
const search = createOpenSearch(process.env.OPENSEARCH_URL!);
let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
let options: PersonasOptions;
let personas: Awaited<ReturnType<typeof createPersonas>>;
let kernel: TestKernel;
let initialized: Promise<void> | undefined;

// The check runner owns this one isolated kernel database. Auth uses its canonical native fixture;
// no second kernel, Actor registry, SQL source truth or synthetic credential is provisioned here.
function fixture() {
  return (initialized ??= (async () => {
    await bootstrapRelease(pool, bundledRelease);
    auth = await nativeFixture(pool);
    options = { version: 1, pool, auth };
    const service = auth.host.service;
    kernel = testKernel({
      pool,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      writeRate: createWriteRateLimiter({ secret: 'search-erasure-native-write-rate-secret-32-bytes' }),
    });
    personas = await createPersonas(kernel, options);
  })());
}
afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await pool.end();
  }
});

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, stage: string) {
  const deadline = Date.now() + 20_000;
  let last: T;
  do {
    last = await read();
    if (accepts(last)) return last;
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`${stage}: ${JSON.stringify(last)}`);
}

// Separate SDK process, preserving every default module in order. Decorators observe the real
// addEffects/addService calls in composeWork, forwarding every original effect and starter unchanged.
const workerProgram = `
  import { startWorker, readWorkerConfig } from './src/worker.ts';
  import { createDiscoveryProducerEntry } from './src/composition/discovery.ts';
    import { createKernelWorkModules } from './src/work/modules.ts';
    const KERNEL_WORK_MODULES = createKernelWorkModules(createDiscoveryProducerEntry);
  import { createOutcomeRpc } from './test/search/support/outcome-rpc.ts';
  import { createSearchRunnerSlot } from './test/search/support/runner-slot.ts';
  const slot = createSearchRunnerSlot();
  const registered = [];
  const replay = new Map();
  let worker, starting;
  const modules = KERNEL_WORK_MODULES.map(module => ({
    name: module.name,
    async register(context) {
      const observed = { name: module.name, effects: [] };
      registered.push(observed);
      await module.register({ ...context,
        addEffects(actual) {
          observed.effects.push(...actual.map(effect => ({ name: effect.name, types: effect.types })));
          context.addEffects(actual.map(effect => module.name !== 'search' ? effect : {
            ...effect,
            async run(event) {
              replay.set(event.data.accountId, { effect, event });
              return effect.run(event);
            }
          }));
        },
        addService(original) {
          context.addService(async () => {
            const service = await original();
            return module.name === 'search' ? slot.adopt(service, original) : service;
          });
        }
      });
      if (module === KERNEL_WORK_MODULES.at(-1))
        await rpc.request('registered', { defaults: KERNEL_WORK_MODULES.map(m => m.name), registered });
    }
  }));
  const close = async () => {
    await starting?.catch(() => {});
    if (worker) await worker.stop();
    else await slot.stop();
  };
  const rpc = createOutcomeRpc({
    send: packet => new Promise((resolve, reject) => process.send(packet, error => error ? reject(error) : resolve())),
    subscribe(message, failure) {
      process.on('message', message);
      process.on('disconnect', () => { failure(new Error('Parent disconnected')); void close(); });
      process.on('error', failure);
      return () => process.off('message', message);
    }
  }, { timeoutMs: 60000, async onRequest(method, params) {
    if (method === 'init') {
      starting = startWorker(readWorkerConfig(params), modules, params);
      worker = await starting;
      return registered;
    }
    if (method === 'pause') { await slot.pause(); return null; }
    if (method === 'resume') { await slot.resume(); return null; }
    if (method === 'replay') {
      const actual = replay.get(params.accountId);
      if (!actual) throw new Error('No actual Search tombstone effect invocation observed');
      await actual.effect.run(actual.event);
      return null;
    }
    if (method === 'close') { await close(); return null; }
    throw new Error('Unknown native worker control');
  }});
`;
type Registration = {
  defaults: string[];
  registered: { name: string; effects: { name: string; types: string[] }[] }[];
};
async function worker(prefix: string, endpoint?: string) {
  const child = spawn(process.execPath, ['-e', workerProgram], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  const registration = Promise.withResolvers<Registration>();
  const rpc = createOutcomeRpc(
    {
      send: (packet) =>
        new Promise<void>((resolve, reject) => child.send(packet as object, (e) => (e ? reject(e) : resolve()))),
      subscribe(message, failure) {
        child.on('message', message);
        child.on('error', failure);
        child.on('disconnect', () => failure(new Error(`Native worker disconnected: ${output}`)));
        return () => child.off('message', message);
      },
    },
    {
      timeoutMs: 60_000,
      onRequest(method, params) {
        if (method !== 'registered') throw new Error(`Unexpected worker observation: ${method}`);
        registration.resolve(params as Registration);
        return null;
      },
    },
  );
  const ready = rpc.request(
    'init',
    workerTestEnv({
      ...process.env,
      OPENSEARCH_URL: endpoint,
      KERNEL_SEARCH_PREFIX: prefix,
      KERNEL_ROUTE_KEY: Buffer.from(testRouteKey()).toString('base64url'),
    }),
  );
  void ready.catch(registration.reject);
  return {
    rpc,
    ready,
    registered: registration.promise,
    async close() {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
      try {
        try {
          await rpc.request('close');
        } finally {
          if (child.connected) child.disconnect();
        }
        expect(await exited, output).toBe(0);
      } finally {
        clearTimeout(timeout);
        rpc.close();
      }
    },
  };
}

async function post(actor: Persona, path: string, body: unknown, expected = 200) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${actor.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify(body),
    }),
  );
  const result = await response.json();
  expect([response.status, result]).toEqual([expected, expect.anything()]);
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return result as { subject: { id: string }; candidate: string };
}
async function rename(owner: Persona, name: string) {
  const context = { pool, deadline: Date.now() + 10_000 };
  const actor = await auth!.access.authenticate(owner.bearer, context);
  if (actor.kind !== 'account') throw new Error('Native persona did not authenticate as an account');
  await auth!.COMMANDS.lifecycle.updateAccount(
    {
      ...context,
      actor,
    },
    { accountId: owner.accountId, key: crypto.randomUUID(), patch: { displayName: name } },
  );
}
async function outcome(accountId: string) {
  return (await readErasureStatus(pool, accountId))?.participants.search?.outcome;
}
async function documents(index: string, ids: string[]) {
  const { body } = await search.request<{ docs: { _id: string; found: boolean; _source?: SubjectDocument }[] }>(
    'POST',
    `/${index}/_mget`,
    { ids },
  );
  return body.docs.filter((doc) => doc.found).map((doc) => doc._source!);
}
async function dispose(prefix: string) {
  for (const generation of [1, 2, 3]) {
    try {
      await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
    } catch (error) {
      if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
    }
  }
  for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
    try {
      await search.request('DELETE', `/_scripts/${prefix}${template}`);
    } catch (error) {
      if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
    }
  }
}

test('default Search registers the native account-tombstoned participant even without per-account data', async () => {
  await fixture();
  const native = await worker(`erasure-empty-${crypto.randomUUID().slice(0, 8)}-`);
  try {
    const observed = await native.registered;
    expect(observed.registered.map(({ name }) => name)).toEqual(observed.defaults);
    const actual = observed.registered.filter(({ name }) => name === 'search');
    expect(actual).toHaveLength(1);
    // Executable missing-registration red: no required invented export or unconditional port throw.
    expect(actual[0]!.effects.filter(({ types }) => types.includes(tombstone))).toHaveLength(1);
    await native.ready;
    await deletePersona(options, personas.delegated);
    await drainEffects(pool, partitionOf(routeOf(personas.delegated.accountId)!));
    await eventually(
      () => outcome(personas.delegated.accountId),
      (value) => value === 'none',
      'actual no-data attestation',
    );
  } finally {
    await native.close();
  }
}, 360_000);

// Only native transport is scheduled. The same default writer's real old body is held before
// engine dispatch, then its real response is withheld. Neither Source nor an engine result is stubbed.
function transportBarrier() {
  const entered = Promise.withResolvers<void>();
  const dispatch = Promise.withResolvers<void>();
  const applied = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  let target: { index: string; id: string } | undefined;
  let captured = '';
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
      const held =
        !!target &&
        url.pathname.endsWith('/_bulk') &&
        !!body?.split('\n').some((line) => {
          if (!line) return false;
          const metadata = JSON.parse(line) as { index?: { _index: string; _id: string } };
          return metadata.index?._index === target!.index && metadata.index?._id === target!.id;
        });
      if (held) {
        target = undefined;
        captured = body!;
        entered.resolve();
        await dispatch.promise;
      }
      const headers = new Headers(request.headers);
      headers.delete('host');
      const response = await fetch(new URL(url.pathname + url.search, process.env.OPENSEARCH_URL!), {
        method: request.method,
        headers,
        body: body ?? null,
      });
      const bytes = await response.arrayBuffer();
      if (held) {
        applied.resolve();
        await settle.promise;
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    },
  });
  return {
    url: server.url.href,
    entered: entered.promise,
    applied: applied.promise,
    arm(index: string, id: string) {
      target = { index, id };
    },
    captured: () => captured,
    dispatch: () => dispatch.resolve(),
    settle: () => settle.resolve(),
    async close() {
      dispatch.resolve();
      settle.resolve();
      await server.stop();
    },
  };
}

// One pruning schedule only; the independent six-case late-write suite remains authoritative.
async function prune(index: string) {
  type Bulk = { items: { index?: { status: number }; delete?: { status: number } }[] };
  const action = (op: 'index' | 'delete', version: number) => ({
    [op]: { _index: index, _id: 'erasure-retention-probe', version, version_type: 'external' },
  });
  const apply = (lines: unknown[]) => search.bulk<Bulk>(lines, { query: { refresh: true } });
  expect((await apply([action('index', 1), {}])).items[0]!.index!.status).toBe(201);
  expect((await apply([action('delete', 2)])).items[0]!.delete!.status).toBe(200);
  expect((await apply([action('index', 1), {}])).items[0]!.index!.status).toBe(409);
  await search.request('PUT', `/${index}/_settings`, { index: { gc_deletes: '100ms' } });
  await eventually(
    async () => {
      await search.request('POST', `/${index}/_refresh`);
      return (await apply([action('index', 1), {}])).items[0]!.index!.status;
    },
    (status) => status === 201,
    'native delete-version pruning',
  );
}

async function erasure(persona: () => Persona, delayed: boolean) {
  await fixture();
  const owner = persona();
  const prefix = `erasure-${crypto.randomUUID().slice(0, 8)}-`;
  const indices = [1, 2, 3].map((generation) => subjectIndexName(prefix, generation));
  const agent = accountAgentId(owner.accountId);
  const canary = `PersonalCanary${crypto.randomUUID().replaceAll('-', '')}`;
  const title = `PublishedContribution${crypto.randomUUID().replaceAll('-', '')}`;
  const barrier = transportBarrier();
  let native: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    for (const action of ['subject:create', 'statement:propose', 'moderation:hide'])
      await post(
        personas.staff,
        '/v1/grants',
        {
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: owner.accountId },
          actions: [action],
          valid: '(,)',
        },
        201,
      );
    await rename(owner, canary);
    await ensureAccountAgent(pool, { account: owner.accountId, kind: 'person', name: canary, language: 'en' });
    const contribution = await post(
      owner,
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: title },
        descriptions: { en: 'Eligible public contribution' },
        statements: {
          'schema:inLanguage': [
            { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' }, rank: 'normal' },
          ],
          'schema:author': [
            { property: { id: 'schema:author' }, value: { type: 'value', content: agent }, rank: 'normal' },
          ],
        },
      },
      201,
    );
    const withdrawn = await post(
      owner,
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: `${title} withdrawn` },
        descriptions: { en: canary },
      },
      201,
    );
    const privateHolder = await post(
      owner,
      '/v1/subjects',
      {
        type: 'schema:Person',
        labels: { en: 'Public holder of a private assertion' },
      },
      201,
    );
    const holder = privateHolder.subject.id;
    await post(
      owner,
      `/v1/subjects/${holder}/candidates`,
      {
        statement: {
          property: { id: 'rezics:penNameOf' },
          value: { type: 'value', content: agent },
          qualifiers: [],
          references: [],
        },
      },
      201,
    );
    const kept = contribution.subject.id;
    const removed = withdrawn.subject.id;
    const owned = [agent, kept, removed, holder];
    const retainedIds = [kept, holder].sort();
    for (const generation of [1, 2, 3]) await createSubjectIndex(search, prefix, generation);
    // Generation 1 is grace, 2 active, 3 rebuilding; no direct synthetic document population.
    await search.request('PUT', `/${indices[1]}/_mapping`, { _meta: { activated_at: new Date().toISOString() } });
    await search.request('POST', '/_aliases', {
      actions: [{ add: { index: indices[1], alias: subjectAlias(prefix) } }],
    });
    native = await worker(prefix, barrier.url);
    await native.ready;
    const service = auth!.host.service;
    const publicKernel = testKernel({
      pool,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      search: createSearchService({
        pool,
        client: search,
        prefix,
        source: subjectSource(pool, testRouteKey()),
        cursors: testTokens(),
      }),
    });
    async function publicIds(text: string) {
      const response = await publicKernel.handle(
        new Request('http://kernel.test/v1/subjects:search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, limit: 20 }),
        }),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { subjects: { id: string }[] }).subjects.map(({ id }) => id);
    }
    for (const index of indices) {
      const docs = await eventually(
        () => documents(index, owned),
        (docs) => docs.length === owned.length && docs.some((doc) => doc.names.includes(canary)),
        `default population ${index}`,
      );
      expect(JSON.stringify(docs.find(({ id }) => id === holder))).not.toContain(agent);
      expect(JSON.stringify(docs.find(({ id }) => id === kept))).toContain(agent);
    }
    expect(await publicIds(canary)).toContain(agent);
    expect(await publicIds(title)).toContain(kept);
    await post(owner, `/v1/subjects/${removed}:hide`, { reason: 'Withdraw before account erasure' });
    if (delayed) {
      barrier.arm(indices[0]!, agent);
      await rename(owner, `${canary} delayed`);
      await Promise.race([
        barrier.entered,
        Bun.sleep(10_000).then(() => {
          throw new Error('Default native old bulk never reached barrier');
        }),
      ]);
      expect(barrier.captured()).toContain(canary);
    }
    const deletion = await deletePersona(options, owner);
    expect(deletion.accountId).toBe(owner.accountId);
    expect((await readErasureStatus(pool, owner.accountId))?.at).toBe(deletion.at);
    await drainEffects(pool, partitionOf(routeOf(owner.accountId)!));
    if (delayed) expect(await outcome(owner.accountId)).toBe('pending');
    if (delayed) {
      // A participant may wait for the old writer before replacing copies, or replace first and
      // track that unresolved write. Either way, native pruning never licenses an early ACK.
      await prune(indices[0]!);
      expect(await outcome(owner.accountId)).toBe('pending');
      barrier.dispatch();
      await Promise.race([
        barrier.applied,
        Bun.sleep(10_000).then(() => {
          throw new Error('Old native dispatch did not settle');
        }),
      ]);
      expect(await outcome(owner.accountId)).toBe('pending');
      barrier.settle();
    }
    // Source minimization/all-role and foreign-dependency producer ports do not exist yet.
    // Keep these full physical/API assertions: a pending status alone cannot pass this case.
    const clean = (docs: SubjectDocument[]) =>
      JSON.stringify(docs.map(({ id }) => id).sort()) === JSON.stringify(retainedIds) &&
      !JSON.stringify(docs).includes(canary) &&
      !JSON.stringify(docs).includes(agent);
    await eventually(
      async () => {
        const generations = await Promise.all(indices.map((index) => documents(index, owned)));
        if (!generations.every(clean)) expect(await outcome(owner.accountId)).toBe('pending');
        return generations;
      },
      (generations) => generations.every(clean),
      'native cleanup of exact active/rebuilding/grace copies',
    );
    expect(await publicIds(canary)).toEqual([]);
    expect(await publicIds(title)).toEqual([kept]);
    const retained = await kernel.handle(new Request(`http://kernel.test/v1/subjects/${kept}`));
    expect(retained.status).toBe(200);
    const retainedBody = await retained.text();
    expect(retainedBody).toContain(title);
    expect(retainedBody).toContain('schema:inLanguage');
    expect(retainedBody).not.toContain(owner.accountId);
    expect(retainedBody).not.toContain(canary);
    const provenance = await kernel.handle(new Request(`http://kernel.test/v1/subjects/${kept}/revisions`));
    expect(provenance.status).toBe(200);
    const attribution = await provenance.text();
    expect(attribution).not.toContain(owner.accountId);
    expect(attribution).not.toContain(agent);
    await eventually(
      () => outcome(owner.accountId),
      (value) => value === 'erased',
      'separate Search acknowledgement after cleanup',
    );
    for (const index of indices) {
      const docs = await documents(index, owned);
      expect(docs.map(({ id }) => id).sort()).toEqual(retainedIds);
      expect(JSON.stringify(docs)).not.toContain(agent);
      expect(JSON.stringify(docs)).not.toContain(canary);
    }
    const before = await readErasureStatus(pool, owner.accountId);
    await native.rpc.request('replay', { accountId: owner.accountId });
    await drainEffects(pool, partitionOf(routeOf(owner.accountId)!));
    expect(await readErasureStatus(pool, owner.accountId)).toEqual(before);
    await expect(
      acknowledgeErasure({ pool }, { accountId: owner.accountId, participant: 'search', outcome: 'none' }),
    ).rejects.toThrow();
    expect(await readErasureStatus(pool, owner.accountId)).toEqual(before);
    for (const index of indices) expect(await documents(index, [agent, removed])).toEqual([]);
    expect(await publicIds(canary)).toEqual([]);
    expect(await publicIds(title)).toEqual([kept]);
  } finally {
    barrier.dispatch();
    barrier.settle();
    try {
      await native?.close();
    } finally {
      try {
        await barrier.close();
      } finally {
        await dispose(prefix);
      }
    }
  }
}

test(
  'Search cannot acknowledge erasure before all affected live-generation copies and delayed writes are resolved',
  () => erasure(() => personas.alice, true),
  360_000,
);
test(
  'native Search erasure follows fresh Auth confirmation and records its immutable acknowledgement only after actual cleanup',
  () => erasure(() => personas.bob, false),
  360_000,
);

import { assertRetainedPitDeletion } from '../../src/search/erasure-pit.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';

// Receipt validation is one cleanup boundary, not an all-copy participant completion oracle.
test('retained PIT custody can be released only by its exact native successful cleanup receipt', () => {
  const receipt = { pits: [{ pit_id: 'owned-pit', successful: true }] };
  expect(() => assertRetainedPitDeletion('owned-pit', receipt)).not.toThrow();
});

test('failed partial missing and foreign PIT receipts cannot release retained custody', () => {
  const unconfirmed: unknown[] = [
    undefined,
    null,
    {},
    { pits: [] },
    { pits: [{ pit_id: 'owned-pit', successful: false }] },
    { pits: [{ pit_id: 'owned-pit' }] },
    { pits: [{ pit_id: 'other-pit', successful: true }] },
    { pits: [{ pit_id: 'owned-pit', successful: 'true' }] },
    {
      pits: [
        { pit_id: 'owned-pit', successful: true },
        { pit_id: 'other-pit', successful: false },
      ],
    },
    { pits: [{ pit_id: 'owned-pit', successful: true }], error: {} },
    { pits: [{ pit_id: 'owned-pit', successful: true, error: {} }] },
  ];
  for (const receipt of unconfirmed)
    expect(() => assertRetainedPitDeletion('owned-pit', receipt)).toThrow(SearchUnavailableError);
});
