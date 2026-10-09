import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { WorkReadUnavailable, workRead } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { recoveryAccess } from './support/recovery-access.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const agent = id(1);
const untyped = id(2);
const work = id(3);
const privateName = 'Hidden Pen';
const publicTitle = 'Open Title';

function iris(query: string) {
  return [...query.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
}

test('community summaries still probe an Agent and an untyped row, and withhold a private Agent name', async () => {
  const graphCalls: string[] = [];
  const graph = new FusekiClient('http://community-read-guards.invalid');
  graph.query = async query => {
    graphCalls.push(query);
    const refs = (variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
      .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: term('epoch'), sequence: term('7') };
      return { results: { bindings: [
        { ...control, r: uri(agent), type: term('agent'), public: term('true'), head: uri(id(11)),
          label: term(privateName) },
        { ...control, r: uri(untyped) },
        { ...control, r: uri(work), type: term('work'), work: uri(work), head: uri(id(13)),
          public: term('true'), label: { ...term(publicTitle), 'xml:lang': 'en' } },
      ] } };
    }
    if (query.includes('SELECT ?work ?head ?nameOwner')) {
      return { results: { bindings: refs('work').map(reference => ({
        work: uri(reference), head: uri(id(11)),
        ...(reference === agent ? { nameOwner: uri(reference) } : {}),
      })) } };
    }
    if (query.includes('?owningWork')) {
      return { results: { bindings: refs('work').map(reference => ({
        work: uri(reference),
        ...(reference === agent ? { head: uri(id(11)) } : {}),
        ...(reference === work ? { head: uri(id(13)), owningWork: uri(work), owningHead: uri(id(13)) } : {}),
      })) } };
    }
    throw new Error(`Unexpected summary query: ${query.slice(0, 180)}`);
  };
  const pool = { query: async (sql: string, args: unknown[]) => {
    if (!sql.includes('requested AS')) throw new Error('Unexpected disclosure statement');
    const targets = JSON.parse(String(args[0])) as Array<{ ordinal: number; nameOwner?: string | null }>;
    return { rows: targets.map(target => ({
      ordinal: target.ordinal, open: true, restricted: false, assessments: [],
      nameVisible: target.nameOwner !== agent, publicNameVisible: target.nameOwner !== agent,
    })) };
  } } as unknown as Pool;
  const environment = { fuseki: graph, objectDirectory: '.temp/community-read-guards',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  const result = await readResourceSummaries(environment, undefined, { viewer: ANONYMOUS_VIEWER }, {
    resources: [agent, untyped, work], context: DEFAULT_MEDIA_CONTEXT, language: null,
    settleNonAgentNameOwners: true,
  });
  const probes = graphCalls.filter(query => query.includes('SELECT ?work ?head ?nameOwner'));
  expect(probes).toHaveLength(1);
  const probed = new Set(iris(probes[0]!));
  expect(probed.has(agent)).toBe(true);
  expect(probed.has(untyped)).toBe(true);
  expect(probed.has(work)).toBe(false);
  expect(result.summaries).toEqual([
    { reference: agent, status: 'unavailable' },
    { reference: untyped, status: 'unavailable' },
    expect.objectContaining({ reference: work, status: 'available', name: expect.objectContaining({ value: publicTitle }) }),
  ]);
  expect(JSON.stringify(result)).not.toContain(privateName);
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
  } finally { await server.stop(true); }
});
