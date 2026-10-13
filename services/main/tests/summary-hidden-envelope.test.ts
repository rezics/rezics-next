import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureCut } from './support/disclosure-ancestry.ts';
import { publicSummaryCost, resourceRoutes } from '../src/routes/resources.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const hidden = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const absent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000099';
const visible = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const visibleAlso = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const visibleThird = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const title = 'Secret title';
const visibleTitle = 'Public title';
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

function app() {
  let hydrations = 0;
  const graph = new FusekiClient('http://summary-hidden-envelope.invalid');
  graph.query = async query => {
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?epoch ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: term('epoch'), sequence: term('7') }] } };
    }
    if (query.includes('SELECT ?resource ?head WHERE')) {
      return { results: { bindings: [...query.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => ({ resource: uri(iri[1]!), head: uri(iri[1]!) }))) } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: term('epoch'), sequence: term('7') };
      const bindings = [control];
      for (const [reference, label] of [[hidden, title], [visible, visibleTitle], [visibleAlso, visibleTitle],
        [visibleThird, visibleTitle]]) {
        if (query.includes(`<${reference}>`)) bindings.push({ ...control, r: uri(reference), type: term('work'),
          work: uri(reference), head: uri(reference), public: term('true'),
          label: { ...term(label), 'xml:lang': 'en' } } as never);
      }
      return { results: { bindings } };
    }
    if (query.includes('SELECT ?work ?head ?nameOwner') || query.includes('SELECT ?work ?head ?owningWork')) {
      const refs = [...query.matchAll(/<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/g)].map(match => match[0].slice(1, -1));
      return { results: { bindings: [...new Set(refs)].map(work => ({ work: uri(work) })) } };
    }
    throw new Error(`Unexpected graph query: ${query.replace(/\s+/g, ' ').slice(0, 180)}`);
  };
  const pool = { query: async (sql: string, args?: unknown[]) => {
    if (!sql.includes('requested AS')) throw new Error('Unexpected disclosure statement');
    const targets = JSON.parse(String(args?.[0])) as Array<{ ordinal: number; resource: string }>;
    return { rows: targets.map(target => ({ ordinal: target.ordinal, open: true,
      restricted: target.resource === hidden, realmClosed: false, assessments: [], ...fixtureDisclosureCut,
      nameVisible: true, publicNameVisible: true })) };
  } } as unknown as Pool;
  const environment = { fuseki: graph, objectDirectory: '.temp/summary-hidden-envelope',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  configureFixtureDisclosureAncestry(environment, target => target.work ? { resource: target.work, head: target.work,
    ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) } : undefined);
  const work = {
    environment,
    account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
    access: { assertRecoveryOpen: async () => undefined, activePrincipalId: async () => visible },
    media: { store: { avatarRows: async () => {
      hydrations++;
      return { rows: new Map(), generation: { owner: 'content' as const, dataEpoch: 'media', sequence: '9' } };
    } } },
  } as unknown as MainWorkDependencies;
  return { app: new Elysia().use(resourceRoutes(graph, work)), hydrations: () => hydrations };
}

interface Envelope {
  profile: string; complete: boolean;
  summaries: Array<{ reference: string; status: string }>;
  generation: { graph: string; media: string | null; addresses?: string };
  cost: { graphQueries: number; mediaQueries: number; accessChecks: number; accessQueries: number };
}

function unavailableAddress(reference: string) {
  return createHash('sha256').update(JSON.stringify([[reference]])).digest('hex');
}

test('a hidden summary id and an absent id share one response envelope', async () => {
  const f = app();
  const send = async (resources: readonly string[], authorization?: string) => {
    const response = await f.app.handle(new Request('http://main.local/v1/resources/summaries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ profile: 'resource-summary-batch-v1', resources }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return { status: response.status, body: await response.json() as Envelope };
  };
  for (const authorization of [undefined, 'Bearer reader']) {
    const concealedResponse = await send([hidden], authorization);
    const missingResponse = await send([absent], authorization);
    const concealed = concealedResponse.body;
    const missing = missingResponse.body;
    expect(concealed.summaries).toEqual([{ reference: hidden, status: 'unavailable' }]);
    expect(missing.summaries).toEqual([{ reference: absent, status: 'unavailable' }]);
    expect(concealedResponse.status).toBe(missingResponse.status);
    expect(JSON.stringify(concealed)).not.toContain(title);
    expect(concealed.cost).toEqual(missing.cost);
    expect(concealed.cost.mediaQueries).toBe(0);
    expect(concealed.generation.media).toBeNull();
    expect(concealed.generation.graph).toMatch(/^[a-f0-9]{64}$/);
    expect(missing.generation.graph).toMatch(/^[a-f0-9]{64}$/);
    expect((await send([hidden], authorization)).body.generation.graph).toBe(concealed.generation.graph);
    expect((await send([absent], authorization)).body.generation.graph).toBe(missing.generation.graph);
    expect(concealed.generation.media).toBe(missing.generation.media);
    expect(Object.keys(concealed.generation).sort()).toEqual(Object.keys(missing.generation).sort());
    expect(Object.keys(concealed).sort()).toEqual(Object.keys(missing).sort());
    expect(concealed.generation.addresses).toBe(unavailableAddress(hidden));
    expect(missing.generation.addresses).toBe(unavailableAddress(absent));
    expect(concealed.profile).toBe(missing.profile);
    expect(concealed.complete).toBe(missing.complete);
  }
  expect(f.hydrations()).toBe(0);

  const mixedResponse = await send([hidden, absent, visible]);
  const allVisibleResponse = await send([visible, visibleAlso, visibleThird]);
  expect(mixedResponse.status).toBe(allVisibleResponse.status);
  expect(mixedResponse.body.cost).toEqual(allVisibleResponse.body.cost);
  expect(Object.keys(mixedResponse.body).sort()).toEqual(Object.keys(allVisibleResponse.body).sort());
  expect(Object.keys(mixedResponse.body.cost).sort()).toEqual(Object.keys(allVisibleResponse.body.cost).sort());
  expect(mixedResponse.body.summaries.map(summary => summary.status))
    .toEqual(['unavailable', 'unavailable', 'available']);
  expect(allVisibleResponse.body.summaries.map(summary => summary.status))
    .toEqual(['available', 'available', 'available']);

  const duplicateResponse = await send([hidden, hidden]);
  expect(duplicateResponse.body.summaries).toEqual([
    { reference: hidden, status: 'unavailable' }, { reference: hidden, status: 'unavailable' },
  ]);
  expect(duplicateResponse.body.cost).toEqual(publicSummaryCost(2));
  expect(duplicateResponse.body.cost).not.toEqual(publicSummaryCost(1));

  // The request schema rejects more than 64 members, so exercise its meter projection at 65 directly.
  const requestIds = (count: number) => Array.from({ length: count }, (_, index) =>
    `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
  const atCap = await send(requestIds(64));
  const overCapCost = publicSummaryCost(requestIds(65).length);
  expect(atCap.body.cost).toEqual({ graphQueries: 67, mediaQueries: 0, accessChecks: 0, accessQueries: 0 });
  expect(overCapCost).toEqual(atCap.body.cost);
});
