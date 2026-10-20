import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { resourceRoutes } from '../src/routes/resources.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

function fixture(kind: 'realm' | 'merged' | 'collection') {
  const source = id(1), survivor = id(2), realm = id(3), space = id(4);
  const state = { sequence: 7, private: false, positionReads: 0, summaryReads: 0, armed: false, paused: false };
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const graph = new FusekiClient('http://graph.invalid/summary-race');
  graph.query = async body => {
    if (body.includes('ASK')) return { boolean: true };
    if (body.includes('SELECT ?epoch ?sequence WHERE')) {
      state.positionReads++;
      if (state.armed && kind === 'realm' && state.positionReads === 2 && !state.paused) {
        state.paused = true; reached(); await held;
      }
      return { results: { bindings: [{ epoch: term('epoch'), sequence: term(String(state.sequence)) }] } };
    }
    if (body.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const requested = [...body.match(/VALUES \?r \{([^}]+)\}/)![1]!.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
      if (state.armed && kind === 'merged' && requested.includes(survivor) && !requested.includes(source) && !state.paused) {
        state.paused = true; reached(); await held;
      }
      state.summaryReads++;
      const control = { epoch: term('epoch'), sequence: term(String(state.sequence)) };
      return { results: { bindings: [control, ...requested.map(reference => ({ ...control, r: uri(reference),
        type: term(kind === 'merged' ? 'work' : kind), head: uri(id(10)), public: term(String(!state.private)),
        ...(kind === 'collection' ? { label: { ...term('Public Collection title'), 'xml:lang': 'en' } } : {}),
        ...(kind === 'merged' ? { work: uri(reference), label: { ...term('Survivor title'), 'xml:lang': 'en' },
          ...(reference === source ? { mergedInto: uri(survivor) } : {}) } : {}) }))] } };
    }
    if (body.includes('SELECT ?realm ?name')) return { results: { bindings: state.private ? []
      : [{ realm: uri(realm), name: { ...term('Selected Realm title'), 'xml:lang': 'en' } }] } };
    if (body.includes('SELECT ?realm ?payload')) return { results: { bindings: [{ realm: uri(realm) }] } };
    if (body.includes('SELECT ?resource ?space ?site')) return { results: { bindings: [
      { resource: uri(realm), space: uri(space), site: term('false') },
    ] } };
    if (body.includes('SELECT ?epoch ?sequence ?hold')) return { results: { bindings: [
      { epoch: term('epoch'), sequence: term(String(state.sequence)) },
    ] } };
    return { results: { bindings: [] } };
  };
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    access: { assertRecoveryOpen: async () => {} } } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => target.work
    ? { resource: target.work, head: id(10), protectedRevision: target.workRevision } : undefined);
  const original = graph.query.bind(graph);
  graph.query = async (...args) => args[0].includes('SELECT ?resource ?head')
    ? { results: { bindings: [...args[0].match(/VALUES \?resource \{([^}]+)\}/)![1]!.matchAll(/<([^>]+)>/g)]
      .map(match => ({ resource: uri(match[1]!), head: uri(id(10)) })) } }
    : original(...args);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.resource === realm && state.private ? 'hidden' : 'visible')));
  const app = new Elysia().use(resourceRoutes(graph, deps));
  const request = () => app.handle(new Request('http://main.test/v1/resources/summaries', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      profile: 'resource-summary-batch-v1', resources: [kind === 'realm' ? realm : source],
    }),
  }));
  return { state, request, entered, release, source, survivor, realm };
}

test('summary API replays a Realm made private after hydration before the closing position read and omits its title', async () => {
  const f = fixture('realm');
  const baseline = await f.request();
  expect(baseline.status).toBe(200); expect(await baseline.text()).toContain('Selected Realm title');
  f.state.positionReads = 0; f.state.armed = true;
  const pending = f.request();
  await Promise.race([f.entered, pending.then(() => { throw new Error('Summary API bypassed its closing race hook'); })]);
  f.state.private = true; f.state.sequence++;
  f.release();
  const response = await pending, text = await response.text();
  expect(response.status).toBe(200); expect(text).not.toContain('Selected Realm title');
  expect(JSON.parse(text).summaries).toEqual([{ reference: f.realm, status: 'unavailable' }]);
  expect(f.state.positionReads).toBe(4);
});

test('the public summary API admits a named Collection and withholds it after private disclosure', async () => {
  const f = fixture('collection');
  const response = await f.request();
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.summaries).toHaveLength(1);
  expect(page.summaries[0]).toMatchObject({ reference: f.source, status: 'available', type: 'collection',
    name: { value: 'Public Collection title' }, address: { prefix: '/e/' } });
  f.state.private = true; f.state.sequence++;
  const hidden = await f.request();
  expect(hidden.status).toBe(200);
  const body = await hidden.text();
  expect(JSON.parse(body).summaries).toEqual([{ reference: f.source, status: 'unavailable' }]);
  expect(body).not.toContain('Public Collection title');
});

test('summary API ignores an unrelated write between merged source and survivor hydration in one attempt', async () => {
  const f = fixture('merged');
  const baseline = await f.request();
  expect(baseline.status).toBe(200); const before = await baseline.json();
  f.state.positionReads = 0; f.state.armed = true;
  const pending = f.request();
  await Promise.race([f.entered, pending.then(() => { throw new Error('Summary API bypassed its survivor race hook'); })]);
  f.state.sequence++; f.release();
  const response = await pending;
  expect(response.status).toBe(200); expect(await response.json()).toEqual(before);
  expect(f.state.positionReads).toBe(2);
});
