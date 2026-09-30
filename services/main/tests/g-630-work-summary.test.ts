import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

function fixture(state: 'protected' | 'erased' | 'superseded') {
  const work = id(), main = id(), head = id();
  let query = '', grants = 0;
  const literal = (value: string) => ({ type: 'literal', value });
  const bindings: NonNullable<SparqlResult['results']>['bindings'] =
    [work, main].map(reference => ({ epoch: literal('epoch'), sequence: literal('7'),
      r: literal(reference), type: literal(reference === work ? 'work' : 'main-version'),
      work: literal(work), head: literal(head), public: literal(state !== 'superseded' ? 'true' : 'false'),
      erased: literal(state !== 'superseded' ? 'true' : 'false'),
      label: { ...literal('Work title'), 'xml:lang': 'en' } }));
  if (state === 'protected') bindings.push({ epoch: literal('epoch'), sequence: literal('7'),
    r: literal(work), type: literal('resource'), public: literal('true'), erased: literal('false'),
    label: { ...literal('Semantic title'), 'xml:lang': 'en' } });
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, fuseki: {
    query: async (text: string) => { query = text.replace(/\s+/g, ' '); return { results: { bindings } }; },
  } } as unknown as WorkActivationEnvironment;
  const read = (granted: boolean) => readResourceSummaries(env, undefined,
    granted ? { canReadWork: async () => { grants++; return true; },
      canReadSemantic: async () => { grants++; return true; } } : {},
    { resources: [work, main], context: DEFAULT_MEDIA_CONTEXT, language: null });
  return { read, query: () => query, grants: () => grants };
}

// These query-contract assertions guard the RDF eligibility probes. The G630
// integration test independently exercises the predicates against real RDF.
test('G630 summary: protected Works and MainVersions are dropped before Access grant checks', async () => {
  const f = fixture('protected');
  expect((await f.read(true)).summaries.map(item => item.status)).toEqual(['unavailable', 'unavailable']);
  expect(f.grants()).toBe(0);
  expect(f.query()).toMatch(/BIND\(IF\(\?type IN \("work", "main-version", "release", "occurrence", "realization"\), EXISTS/);
  expect(f.query()).toMatch(/\|\| EXISTS \{ GRAPH <[^>]+> \{ \?work rv:protectionHead \?protection \} \}, false\)/);
});

test('G630 summary: an erased Work head hides Work and MainVersion titles even with a grant', async () => {
  const f = fixture('erased');
  expect((await f.read(true)).summaries.map(item => item.status)).toEqual(['unavailable', 'unavailable']);
  expect(f.grants()).toBe(0);
  expect(f.query()).toContain('{ ?work rv:head ?erasedHead }');
  expect(f.query()).toContain('{ ?erasedHead a rv:ErasedRevision }');
  expect(f.query()).toMatch(/BIND\(IF\(\?type IN \("work", "main-version", "release", "occurrence", "realization"\), EXISTS/);
});

test('G630 summary: an old public selection requires the Contribution current public decision and exact draft', async () => {
  const f = fixture('superseded');
  expect((await f.read(false)).summaries.map(item => item.status)).toEqual(['unavailable', 'unavailable']);
  expect((await f.read(true)).summaries.map(item => item.status === 'available' ? item.disclosure : item.status))
    .toEqual(['restricted', 'restricted']);
  expect(f.query()).toContain('?publicContribution rv:work ?work ; rv:publicationHead ?publicDecision');
  expect(f.query()).toContain('rv:contribution ?publicContribution ; rv:publicationDecision ?publicDecision ; rv:selectedDraft ?publicDraft');
  expect(f.query()).toContain('rv:disclosure rv:Public ; rv:selectedDraft ?publicDraft');
});
