import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { fieldStates } from '../fixtures/catalogue-information-matrix.ts';
import type { PersonaSessions } from '../support/personas.ts';
import {
  allPersonas, assertField, assertIdentity, body, factGroups, loadInformationCorpus,
  noHidden, openInformationCorpus, publicRead, relations, resourcePath,
  type EntityPage, type InformationCorpus,
} from './support/catalogue-information.ts';

type Failure = 'summary' | 'facts' | 'recipe' | 'chapter';

/** A transport fault in front of the real isolated Fuseki, not a replacement
 * for our read modules, admission, resolver, rights owner or source responses. */
function graphFaultProxy(upstream: string) {
  const target = new URL(upstream);
  let selected: { kind: Failure; reference: string; fail: boolean } | undefined;
  let hits = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    const raw = request.method === 'POST' ? await request.clone().text() : '';
    const query = url.searchParams.get('query') ?? new URLSearchParams(raw).get('query') ?? raw;
    const section = selected?.kind === 'summary' ? query.includes('SELECT ?epoch ?sequence ?hold ?r ')
      : selected?.kind === 'facts' ? /rdf:subject|rv:statementSubject|rv:Statement/.test(query) : true;
    if (selected && section && query.includes(selected.reference)) {
      hits++;
      if (selected.fail) return new Response('Selected isolated dependency unavailable', { status: 503 });
    }
    const forwarded = new Request(new URL(url.pathname + url.search, target.origin), request);
    forwarded.headers.delete('host');
    return fetch(forwarded);
  } });
  return {
    endpoint: new URL(target.pathname, server.url).href,
    select(kind: Failure, reference: string, fail: boolean) { selected = { kind, reference, fail }; hits = 0; },
    hits: () => hits,
    clear() { selected = undefined; },
    close: () => server.stop(true),
  };
}

setDefaultTimeout(120_000);
let corpus: InformationCorpus;
let sessions: PersonaSessions;
let fault: ReturnType<typeof graphFaultProxy>;

async function failedSection(read: ReturnType<typeof publicRead>, href: string): Promise<void> {
  const response = await read(href);
  expect(response.status, await response.clone().text()).toBe(503);
  const retry = response.headers.get('retry-after');
  expect(retry).not.toBeNull();
  expect(Number(retry)).toBeGreaterThanOrEqual(0);
  expect(Number(retry)).toBeLessThanOrEqual(30);
  const refusal = await response.json();
  expect(refusal).not.toBeNull();
  expect(refusal).not.toEqual([]);
  expect(refusal).not.toHaveProperty('groups');
  noHidden(refusal, corpus);
}

describe('C17/C31: independent failures and explicit information states', () => {
  beforeAll(async () => {
    corpus = loadInformationCorpus();
    if (!Bun.env.FUSEKI_URL) throw new Error('Isolated Fuseki URL is required');
    fault = graphFaultProxy(Bun.env.FUSEKI_URL);
    sessions = await openInformationCorpus(corpus, fault.endpoint);
    // Check the real query selectors with failure disabled during setup.
    // A stale selector is a fixture defect, never an expected product failure.
    const read = publicRead(sessions.visitor);
    for (const key of ['person', 'recipe'] as const) {
      fault.select('summary', corpus.records[key].resource, false);
      await body(read, resourcePath(corpus.records[key].resource, 'page'));
      expect(fault.hits(), `${key} summary fault selector`).toBeGreaterThan(0);
    }
    fault.select('facts', corpus.records.person.resource, false);
    await body(read, resourcePath(corpus.records.person.resource, 'statements'));
    expect(fault.hits(), 'facts fault selector').toBeGreaterThan(0);
    for (const kind of ['recipe', 'chapter'] as const) {
      const section = corpus.controls.recovery[kind];
      fault.select(kind, section.queryReference, false);
      const result = await body(read, section.href);
      expect(result, `${kind} must have a genuinely public, non-null read`).not.toBeNull();
      expect(result).toMatchObject(section.identity);
      expect(fault.hits(), `${kind} fault selector`).toBeGreaterThan(0);
    }
    fault.clear();
  }, 600_000);
  afterAll(async () => {
    try { await sessions?.close(); }
    finally { fault?.close(); }
  });

  for (const persona of allPersonas) {
    test(`${persona}: null, empty, zero, unknown, unmapped and withheld facts remain different`, async () => {
      const read = publicRead(sessions[persona]);
      for (const state of fieldStates) {
        const control = corpus.controls.states[state];
        assertField(await factGroups(read, control.resource, corpus), control.field);
      }
      for (const control of Object.values(corpus.controls.values))
        assertField(await factGroups(read, control.resource, corpus), control.field);
      expect(await factGroups(read, corpus.controls.empty, corpus)).toEqual([]);
      expect(await body(read, `/v1/recipes/works/${corpus.controls.nullRecipe.slice(-36)}`)).toBeNull();
      const missing = await read(resourcePath(corpus.controls.missing, 'page'));
      expect(missing.status).toBe(404);
      noHidden(await missing.json(), corpus);
    });

    for (const key of ['person', 'recipe'] as const) {
      test(`${persona}: ${key} keeps known identity and type when only summary/name fails, then recovers`, async () => {
        const read = publicRead(sessions[persona]);
        const href = resourcePath(corpus.records[key].resource, 'page');
        const before = await body<EntityPage>(read, href);
        fault.select('summary', corpus.records[key].resource, true);
        try {
          const response = await read(href);
          expect(response.status, await response.clone().text()).toBe(200);
          expect(response.headers.get('retry-after')).not.toBeNull();
          expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(0);
          expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(30);
          const partial = await response.json() as EntityPage;
          assertIdentity(partial, key, corpus);
          expect(partial.target).toEqual(before.target);
          expect(partial.sections).toEqual(before.sections);
          expect(partial.summary).toEqual({ reference: corpus.records[key].resource, status: 'unavailable' });
          const facts = await factGroups(read, corpus.records[key].resource, corpus);
          for (const field of corpus.records[key].fields) assertField(facts, field);
          expect(fault.hits()).toBeGreaterThan(0);
        } finally { fault.clear(); }
        const recovered = await body<EntityPage>(read, href);
        expect(recovered.target).toEqual(before.target);
        expect(recovered.summary).toEqual(before.summary);
      });
    }

    test(`${persona}: failed facts keep identity, inverse paths and section href, with bounded retry and recovery`, async () => {
      const read = publicRead(sessions[persona]);
      const resource = corpus.records.person.resource;
      const before = await body<EntityPage>(read, resourcePath(resource, 'page'));
      const connections = await relations(read, resource, corpus);
      const href = before.sections.find(section => section.id === 'statements')!.href;
      fault.select('facts', resource, true);
      try {
        await failedSection(read, href);
        const partial = await body<EntityPage>(read, resourcePath(resource, 'page'));
        assertIdentity(partial, 'person', corpus);
        expect(partial.target).toEqual(before.target);
        expect(partial.sections).toEqual(before.sections);
        expect(await relations(read, resource, corpus)).toEqual(connections);
        expect(fault.hits()).toBeGreaterThan(0);
      } finally { fault.clear(); }
      const recovered = await factGroups(read, resource, corpus);
      for (const field of corpus.records.person.fields) assertField(recovered, field);
    });

    for (const kind of ['recipe', 'chapter'] as const) {
      test(`${persona}: unavailable ${kind} keeps the same public Work and successful facts, then retries the same section`, async () => {
        const read = publicRead(sessions[persona]);
        const section = corpus.controls.recovery[kind];
        const key = kind === 'recipe' ? 'recipe' : 'book';
        const pageHref = resourcePath(section.resource, 'page');
        const before = await body<EntityPage>(read, pageHref);
        const facts = await factGroups(read, section.resource, corpus);
        fault.select(kind, section.queryReference, true);
        try {
          await failedSection(read, section.href);
          const partial = await body<EntityPage>(read, pageHref);
          assertIdentity(partial, key, corpus);
          expect(partial.target).toEqual(before.target);
          expect(partial.sections).toEqual(before.sections);
          expect(await factGroups(read, section.resource, corpus)).toEqual(facts);
          expect(fault.hits()).toBeGreaterThan(0);
        } finally { fault.clear(); }
        expect(await body(read, section.href)).toMatchObject(section.identity);
      });
    }
  }
});
