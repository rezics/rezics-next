import { fixtureDisclosureCut } from './support/disclosure-ancestry.ts';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { resolveSummary, visibleResourceReferences } from '../src/modules/entity-page/read.ts';
import { readPageRelations } from '../src/modules/entity-page/relations.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { readReadingComposition } from '../src/modules/reading-position/boundary.ts';
import { SemanticTargetUnavailable } from '../src/modules/semantic/command.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { WorkReadMissing, WorkReadSession, WorkReadUnavailable, workRead } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { recoveryAccess } from './support/recovery-access.ts';
import { targetSummaries } from '../src/modules/target/resolve.ts';
import { assertHiddenIdEquality, type HiddenIdCounters } from '../../../tests/qa/support/hidden-id-equality.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const agent = id(1);
const untyped = id(2);
const work = id(3);
const absent = id(4);
const hidden = id(5);
const privateAgent = id(6);
const privateName = 'Hidden Pen';
const publicTitle = 'Open Title';

function iris(query: string) {
  return [...query.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
}

function summaryFixture(absenceEvidence = true) {
  const graphCalls: string[] = [];
  let sqlStatements = 0, bytes = 0;
  const graph = new FusekiClient('http://community-read-guards.invalid');
  graph.query = async query => {
    graphCalls.push(query);
    const refs = (variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
      .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: term('epoch'), sequence: term('7') };
      return { results: { bindings: [
        ...refs('r').flatMap(reference => {
          const proof = query.includes('?hasCurrentIdentity') && (reference !== absent || absenceEvidence)
            ? { hasCurrentIdentity: term(reference === absent ? 'false' : 'true') } : {};
          const identity = { ...control, r: uri(reference), ...proof };
          if (reference === agent) return [{ ...identity, type: term('agent'),
            public: term('true'), head: uri(id(11)), label: term(privateName) }];
          if (reference === untyped) return [identity];
          if (reference === work) return [{ ...identity, type: term('work'), work: uri(work),
            head: uri(id(13)), public: term('true'), label: { ...term(publicTitle), 'xml:lang': 'en' } }];
          if (reference === hidden) return [{ ...identity, type: term('space'),
            public: term('true'), label: { ...term('Hidden space'), 'xml:lang': 'en' } }];
          return query.includes('?hasCurrentIdentity') ? [identity] : [];
        }),
        control,
      ] } };
    }
    if (query.includes('SELECT ?work ?head ?nameOwner')) {
      return { results: { bindings: refs('work').map(reference => ({
        work: uri(reference), head: uri(id(11)),
        ...([agent, privateAgent].includes(reference) ? { nameOwner: uri(reference) } : {}),
      })) } };
    }
    if (query.includes('?owningWork')) {
      return { results: { bindings: refs('work').map(reference => ({
        work: uri(reference),
        ...(reference === agent ? { head: uri(id(11)) } : {}),
        ...(reference === work ? { head: uri(id(13)), owningWork: uri(work), owningHead: uri(id(13)) } : {}),
      })) } };
    }
    if (query.includes('SELECT ?epoch ?sequence')) {
      return { results: { bindings: [{ epoch: term('epoch'), sequence: term('7') }] } };
    }
    if (query.includes('SELECT DISTINCT ?relation ?kind ?key') || query.includes('rv:OccurrencePlacement')) {
      return { results: { bindings: [] } };
    }
    throw new Error(`Unexpected summary query: ${query.slice(0, 180)}`);
  };
  const pool = { query: async (sql: string, args: unknown[]) => {
    sqlStatements++;
    if (!sql.includes('requested AS')) throw new Error('Unexpected disclosure statement');
    const targets = JSON.parse(String(args[0])) as Array<{ ordinal: number; resource: string; nameOwner?: string | null }>;
    return { rows: targets.map(target => ({
      ordinal: target.ordinal, open: true, realmClosed: false, ...fixtureDisclosureCut, restricted: target.resource === hidden, assessments: [],
      nameVisible: ![agent, privateAgent].includes(target.nameOwner ?? ''),
      publicNameVisible: ![agent, privateAgent].includes(target.nameOwner ?? ''),
    })) };
  } } as unknown as Pool;
  const environment = { fuseki: graph, objectDirectory: '.temp/community-read-guards',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  const session = new WorkReadSession({ environment, account: {} as never,
    access: recoveryAccess() as never }, new Request('http://main.test/v1/resources?position=all'),
  {}, { dataEpoch: 'epoch', sequence: '7' });
  return { environment, session, graphCalls,
    countResponse: async (response: Response) => {
      bytes += (await response.clone().arrayBuffer()).byteLength;
      return response;
    },
    counters: (): HiddenIdCounters => ({ graphCalls: graphCalls.length, sqlStatements, bytes,
      mediaGenerations: 0, rateLimitCharges: 0 }),
  };
}

test('community summaries still probe an Agent, absent identity and untyped row, and withhold a private Agent name', async () => {
  const { environment, graphCalls } = summaryFixture();
  const result = await readResourceSummaries(environment, undefined, { viewer: ANONYMOUS_VIEWER }, {
    resources: [agent, untyped, absent, work], context: DEFAULT_MEDIA_CONTEXT, language: null,
    settleNonAgentNameOwners: true,
  });
  const probes = graphCalls.filter(query => query.includes('SELECT ?work ?head ?nameOwner'));
  expect(probes).toHaveLength(1);
  const probed = new Set(iris(probes[0]!));
  expect(probed.has(agent)).toBe(true);
  expect(probed.has(untyped)).toBe(true);
  expect(probed.has(absent)).toBe(true);
  expect(probed.has(work)).toBe(false);
  expect(result.summaries).toEqual([
    { reference: agent, status: 'unavailable' },
    { reference: untyped, status: 'unavailable' },
    { reference: absent, status: 'unavailable' },
    expect.objectContaining({ reference: work, status: 'available', name: expect.objectContaining({ value: publicTitle }) }),
  ]);
  expect(JSON.stringify(result)).not.toContain(privateName);
});

const summaryAdapters = [
  { name: 'page summary', read: async (session: WorkReadSession, resource: string) => {
    try { return await resolveSummary(session, resource); }
    catch (error) { if (error instanceof WorkReadMissing) return null; throw error; }
  } },
  { name: 'page references', read: async (session: WorkReadSession, resource: string) =>
    (await visibleResourceReferences(session, [resource])).has(resource) ? resource : null },
  { name: 'page relations', read: async (session: WorkReadSession, resource: string) => {
    try { return await readPageRelations(session, resource); }
    catch (error) {
      if (error instanceof SemanticTargetUnavailable) return null;
      throw error;
    }
  } },
  { name: 'reading boundary', read: async (session: WorkReadSession, resource: string) => {
    try { return await readReadingComposition(session, resource); }
    catch (error) { if (error instanceof WorkReadMissing) return null; throw error; }
  } },
];

const equalityAdapters = [...summaryAdapters,
  { name: 'WorkReadSession.summaries', read: (session: WorkReadSession, resource: string) => session.summaries([resource]) },
  { name: 'targetSummaries', read: async (session: WorkReadSession, resource: string) => {
    const batch = await targetSummaries(session, [resource]);
    return { summaries: batch.summaries, cost: batch.cost };
  } },
];

for (const adapter of equalityAdapters) {
  test(`${adapter.name} gives hidden and absent ids the same response and read cost`, async () => {
    const fixture = summaryFixture();
    const observations: Array<{ id: string; counters: HiddenIdCounters }> = [];
    try {
      const compare = () => assertHiddenIdEquality({ operation: adapter.name, hiddenId: hidden, absentId: absent,
        readCounters: fixture.counters,
        call: async resource => {
          const before = fixture.counters();
          const result = await adapter.read(fixture.session, resource);
          if (adapter.name === 'targetSummaries') expect(result).toMatchObject({
            cost: { graphQueries: 2, mediaQueries: 0, accessChecks: 0, accessQueries: 1 },
          });
          const response = await fixture.countResponse(Response.json(result));
          const after = fixture.counters();
          observations.push({ id: resource, counters: {
            graphCalls: after.graphCalls - before.graphCalls, sqlStatements: after.sqlStatements - before.sqlStatements,
            bytes: after.bytes - before.bytes, mediaGenerations: after.mediaGenerations - before.mediaGenerations,
            rateLimitCharges: after.rateLimitCharges - before.rateLimitCharges,
          } });
          return response;
        },
      });
      await compare();
      expect(observations.map(row => row.counters.graphCalls)).toEqual([2, 2]);
      expect(observations.map(row => row.counters.sqlStatements)).toEqual([1, 1]);
    } finally { console.log(`${adapter.name} hidden/absent ${JSON.stringify(observations.map(row => row.counters))}`); }
  });
}

for (const adapter of [
  { name: 'WorkReadSession.summaries', read: (session: WorkReadSession, resources: string[]) => session.summaries(resources) },
  { name: 'targetSummaries', read: async (session: WorkReadSession, resources: string[]) =>
    (await targetSummaries(session, resources)).summaries },
]) {
  test(`${adapter.name} keeps Agent and untyped probes while settling a mixed batch's proven absence`, async () => {
    const { session, graphCalls } = summaryFixture();
    const resources = [work, agent, privateAgent, untyped, absent];
    const summaries = await adapter.read(session, resources);
    expect(summaries[0]).toMatchObject({ reference: work, status: 'available' });
    expect(summaries.slice(1)).toEqual(resources.slice(1).map(reference => ({ reference, status: 'unavailable' })));
    const probes = graphCalls.filter(query => query.includes('SELECT ?work ?head ?nameOwner'));
    expect(probes).toHaveLength(1);
    const probed = new Set(iris(probes[0]!));
    expect(probed.has(work)).toBe(false);
    expect(probed.has(absent)).toBe(false);
    for (const resource of [agent, privateAgent, untyped]) expect(probed.has(resource)).toBe(true);
  });
  test(`${adapter.name} retains its probe if absence evidence is missing`, async () => {
    for (const evidence of [true, false]) {
      const { session, graphCalls } = summaryFixture(evidence);
      expect(await adapter.read(session, [absent])).toEqual([{ reference: absent, status: 'unavailable' }]);
      expect(graphCalls.some(query => query.includes('SELECT ?work ?head ?nameOwner'))).toBe(!evidence);
    }
  });
}

for (const adapter of summaryAdapters) {
  test(`${adapter.name} settles a freshly loaded non-Agent name owner`, async () => {
    const { session, graphCalls } = summaryFixture();
    expect(await adapter.read(session, work)).not.toBeNull();
    expect(graphCalls.some(query => query.includes('SELECT ?work ?head ?nameOwner'))).toBe(false);
  });
  test(`${adapter.name} probes Agents, including a filtered private profile, and untyped identities`, async () => {
    const outputs = [];
    for (const resource of [agent, privateAgent, untyped]) {
      const { session, graphCalls } = summaryFixture();
      outputs.push(await adapter.read(session, resource));
      const probes = graphCalls.filter(query => query.includes('SELECT ?work ?head ?nameOwner'));
      expect(probes.length).toBeGreaterThan(0);
      expect(probes.every(query => iris(query).includes(resource))).toBe(true);
    }
    expect(outputs).toEqual([null, null, null]);
    expect(JSON.stringify(outputs)).not.toContain(privateName);
  });
  test(`${adapter.name} settles absence only with explicit current-identity evidence`, async () => {
    for (const evidence of [true, false]) {
      const { session, graphCalls } = summaryFixture(evidence);
      expect(await adapter.read(session, absent)).toBeNull();
      expect(graphCalls.some(query => query.includes('SELECT ?work ?head ?nameOwner'))).toBe(!evidence);
    }
  });
}

test('page reference batches settle only known non-Agents in a mixed inventory', async () => {
  const { session, graphCalls } = summaryFixture();
  expect(await visibleResourceReferences(session, [work, agent, absent, untyped, work])).toEqual(new Set([work]));
  const probes = graphCalls.filter(query => query.includes('SELECT ?work ?head ?nameOwner'));
  expect(probes).toHaveLength(1);
  const probed = new Set(iris(probes[0]!));
  expect(probed.has(work)).toBe(false);
  expect(probed.has(absent)).toBe(false);
  for (const resource of [agent, untyped]) expect(probed.has(resource)).toBe(true);
});

test('a page reference batch with only foreign ids remains unavailable without claiming absence', async () => {
  const { session, graphCalls } = summaryFixture();
  expect(await visibleResourceReferences(session, ['https://example.com/foreign'])).toEqual(new Set());
  expect(graphCalls).toHaveLength(1);
  expect(graphCalls[0]).not.toContain('BIND(EXISTS');
});

test('the page owner mode gives hidden and absent summaries identical cost fields', async () => {
  const fixture = summaryFixture();
  await assertHiddenIdEquality({ operation: 'page summary owner', hiddenId: hidden, absentId: absent,
    readCounters: fixture.counters,
    call: async resource => {
      const batch = await readResourceSummaries(fixture.environment, undefined, { viewer: ANONYMOUS_VIEWER }, {
        resources: [resource], context: DEFAULT_MEDIA_CONTEXT, language: null,
        settleNonAgentNameOwners: 'includingAbsent',
      });
      expect(batch.cost).toEqual({ graphQueries: 2, mediaQueries: 0, accessChecks: 0, accessQueries: 1 });
      return fixture.countResponse(Response.json({ summaries: batch.summaries, cost: batch.cost }));
    },
  });
});

test('a local summary re-read keeps the same dependency token when name owners stay settled', async () => {
  const queries: string[] = [];
  const graph = new FusekiClient('http://summary-dependency.invalid');
  graph.query = async query => {
    queries.push(query);
    if (query.includes('SELECT ?work ?head ?nameOwner')) throw new Error('Name owner probe');
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      return { results: { bindings: [{
        epoch: term('epoch'), sequence: term('7'), r: uri(work), type: term('work'),
        work: uri(work), head: uri(id(13)), public: term('true'),
        label: { ...term(publicTitle), 'xml:lang': 'en' },
      }] } };
    }
    if (query.includes('SELECT ?epoch ?sequence')) {
      return { results: { bindings: [{ epoch: term('epoch'), sequence: term('7') }] } };
    }
    throw new Error(`Unexpected summary query: ${query.slice(0, 180)}`);
  };
  const pool = { query: async (sql: string) => {
    if (!sql.includes('requested AS')) throw new Error('Unexpected disclosure statement');
    return { rows: [{ ordinal: 0, open: true, realmClosed: false, ...fixtureDisclosureCut, restricted: false, assessments: [], nameVisible: true, publicNameVisible: true }] };
  } } as unknown as Pool;
  const environment = { fuseki: graph, objectDirectory: '.temp/summary-dependency',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  const value = await workRead({ environment, account: {} as never,
    access: recoveryAccess() as never } as MainWorkDependencies,
  new Request('http://main.test/v1/works'), { localBasis: true }, async session => {
    const summaries = await session.summaries([work]);
    return summaries[0];
  });
  expect(value).toEqual(expect.objectContaining({ reference: work, status: 'available' }));
  const summaryReads = queries.filter(query => query.includes('SELECT ?epoch ?sequence ?hold ?r'));
  expect(summaryReads).toHaveLength(2);
  expect(queries.some(query => query.includes('SELECT ?work ?head ?nameOwner'))).toBe(false);
});

test('a read that starts during a recovery hold answers unavailable', async () => {
  const queries: string[] = [];
  let graphHeld = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const body = await request.text();
    queries.push(body);
    const filtersRestoreHold = body.includes('FILTER NOT EXISTS') && body.includes('rv:restoreHold');
    if (graphHeld && filtersRestoreHold) return Response.json({ results: { bindings: [] } });
    return Response.json({ results: { bindings: [{
      epoch: { type: 'literal', value: 'one' }, sequence: { type: 'literal', value: '4' },
    }] } });
  } });
  const graph = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
  const environment = { fuseki: graph, lineage: { dataEpoch: 'one', routingEpoch: 'one' },
    objectDirectory: '.temp/community-read-guards' };
  const request = new Request('http://main.test/v1/works');
  const payload = { delivered: 'community page' };
  try {
    let started = false;
    const dependencies: MainWorkDependencies = { environment, account: {} as never,
      access: recoveryAccess({ open: false }) as never };
    await expect(workRead(dependencies, request, {}, async () => {
      started = true;
      return payload;
    })).rejects.toBeInstanceOf(AdmissionUnavailable);
    expect(started).toBe(true);
    expect(queries[0]).toContain('FILTER NOT EXISTS');
    expect(queries[0]).toContain('rv:restoreHold');
    expect(queries.length).toBeGreaterThan(1);

    queries.length = 0;
    graphHeld = true;
    started = false;
    const open: MainWorkDependencies = { environment, account: {} as never,
      access: recoveryAccess() as never };
    await expect(workRead(open, request, {}, async () => {
      started = true;
      return payload;
    })).rejects.toThrow(WorkReadUnavailable);
    expect(started).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('rv:restoreHold');

    queries.length = 0;
    graphHeld = false;
    started = false;
    const fence = { open: true };
    await expect(workRead({ environment, account: {} as never,
      access: recoveryAccess(fence) as never }, request, {}, async () => {
      started = true;
      fence.open = false;
      return payload;
    })).rejects.toBeInstanceOf(AdmissionUnavailable);
    expect(started).toBe(true);
    expect(queries.length).toBeGreaterThan(1);
  } finally { await server.stop(true); }
});
