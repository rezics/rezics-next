import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { resourceRoutes } from '../src/routes/resources.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const hidden = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const absent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000099';
const title = 'Secret title';
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
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: term('epoch'), sequence: term('7') };
      const bindings = [control];
      if (query.includes(`<${hidden}>`)) bindings.push({ ...control, r: uri(hidden), type: term('work'),
        work: uri(hidden), head: uri(hidden), public: term('true'),
        label: { ...term(title), 'xml:lang': 'en' } } as never);
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
      restricted: target.resource === hidden, assessments: [],
      nameVisible: true, publicNameVisible: true })) };
  } } as unknown as Pool;
  const environment = { fuseki: graph, objectDirectory: '.temp/summary-hidden-envelope',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  const work = {
    environment,
    account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
    access: {},
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
  const send = async (resource: string, authorization?: string) => {
    const response = await f.app.handle(new Request('http://main.local/v1/resources/summaries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ profile: 'resource-summary-batch-v1', resources: [resource] }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return await response.json() as Envelope;
  };
  for (const authorization of [undefined, 'Bearer reader']) {
    const concealed = await send(hidden, authorization);
    const missing = await send(absent, authorization);
    expect(concealed.summaries).toEqual([{ reference: hidden, status: 'unavailable' }]);
    expect(missing.summaries).toEqual([{ reference: absent, status: 'unavailable' }]);
    expect(JSON.stringify(concealed)).not.toContain(title);
    expect(concealed.cost).toEqual(missing.cost);
    expect(concealed.cost.mediaQueries).toBe(0);
    expect(concealed.generation.media).toBeNull();
    expect(concealed.generation.graph).toBe(missing.generation.graph);
    expect(concealed.generation.media).toBe(missing.generation.media);
    expect(Object.keys(concealed.generation).sort()).toEqual(Object.keys(missing.generation).sort());
    expect(Object.keys(concealed).sort()).toEqual(Object.keys(missing).sort());
    expect(concealed.generation.addresses).toBe(unavailableAddress(hidden));
    expect(missing.generation.addresses).toBe(unavailableAddress(absent));
    expect(concealed.profile).toBe(missing.profile);
    expect(concealed.complete).toBe(missing.complete);
  }
  expect(f.hydrations()).toBe(0);
});
