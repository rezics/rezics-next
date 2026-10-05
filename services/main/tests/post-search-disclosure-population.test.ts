import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { queryPublicMainPhrase } from '../src/modules/work/search-public.ts';
import type { PublicTextPosition } from '../src/modules/work/search-readiness.ts';
import { pageCompletePublicRelation } from '../src/modules/work/search-continuation.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const lineage = { dataEpoch: 'graph-epoch', routingEpoch: 'routing' };
const instance = '11111111-1111-4111-8111-111111111111';
const source = { owner: 'content' as const, dataEpoch: 'content-epoch', sequence: '1' };

function fixture(placements: readonly { unit: number; book: number }[], unrelatedUnits = 0) {
  const unitCount = new Set(placements.map(row => row.unit)).size;
  const position: PublicTextPosition = { ...lineage, sequence: '1', population: unitCount + unrelatedUnits,
    generation: `urn:rezics:text-index-generation:${instance}`, serverInstanceId: instance, publicSearchWriteEpoch: '0' };
  const queries: string[] = [], hidden = new Set<string>();
  const graph = new FusekiClient('http://graph.invalid');
  graph.commandHealth = async () => ({ instanceId: instance, moduleVersion: 'test', profiles: {},
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false });
  graph.query = async query => {
    queries.push(query);
    if (query.includes('SELECT ?candidateCount')) return { results: { bindings: placements.map(({ unit, book }) => ({
      epoch: term(position.dataEpoch), sequence: term(position.sequence), indexGeneration: term(position.generation),
      candidateCount: term(String(unitCount)), unit: term(`urn:rezics:unit:${unit}`), score: term('1'),
      work: term(id(unit + 1000)), main: term(id(book + 2000)), contribution: term(id(unit + 1000)),
      revision: term(`urn:rezics:content:revision:${unit}`), selection: term(`urn:rezics:publication:${unit}`),
      language: term('en'), resultWork: term(id(book)), resultMain: term(id(book + 2000)), chapterTitle: term('Chapter'),
      contentProjection: term(`urn:rezics:projection:${unit}`), rightsBasis: term(`${RV}OriginalContribution`),
    })) } };
    if (query.includes('SELECT ?work ?head')) {
      const values = /VALUES \?work \{([^}]+)\}/u.exec(query)![1]!;
      const refs = [...values.matchAll(/<([^>]+)>/gu)].map(match => match[1]!);
      return { results: { bindings: refs.map(work => ({ work: term(work), head: term(id(10000)),
        ...(query.includes('?owningWork') && placements.some(row => id(row.book) === work)
          ? { owningWork: term(work), owningHead: term(id(10000)) } : {}),
      })) } };
    }
    throw new Error(`Unexpected population read: ${query.slice(0, 100)}`);
  };
  const env = { fuseki: graph, lineage, objectDirectory: '.temp/unused' } as WorkActivationEnvironment;
  configureDisclosure(env, { read: async targets => targets.map(target =>
    hidden.has(target.resource) || target.work && hidden.has(target.work) ? 'hidden' : 'visible') });
  const content = { ownerPosition: async () => source } as ContentCore;
  const cursor = { read: async () => source } as unknown as ContentProjectionCursor;
  const read = () => searchGraphSnapshot.run({ clients: new Set([graph]), lineage, position }, () =>
    queryPublicMainPhrase(env, { phrase: 'chapter', language: 'en', contentProjection: { content, cursor, consumer: 'search' } }));
  return { read, hidden, queries };
}

test('A reused Post expands the source census to disclosed Book mains before pagination', async () => {
  const run = fixture([{ unit: 1, book: 1 }, { unit: 1, book: 2 }]);
  expect(await run.read()).toMatchObject({ population: 2, total: 2 });
  run.hidden.add(id(1));
  expect(await run.read()).toMatchObject({ population: 1, total: 1, results: [{ work: id(2) }] });
  run.hidden.add(id(2));
  expect(await run.read()).toMatchObject({ population: 1, total: 0, results: [] });
  run.hidden.clear();
  const relation = await run.read();
  expect(relation).toMatchObject({ population: 2, total: 2 });
  const request = { profile: 'public-main-phrase-page-v1' as const, phrase: 'chapter', language: 'en', pageSize: 1 };
  const first = pageCompletePublicRelation(request, relation);
  expect(first.results).toHaveLength(1);
  expect(first.next).not.toBeNull();
  const second = pageCompletePublicRelation({ ...request, continuation: first.next! }, relation);
  expect(second.results).toHaveLength(1);
  expect(second.results[0]!.work).not.toBe(first.results[0]!.work);
  expect(second.next).toBeNull();
});

test('Several matching chapter units count their Book once while retaining the unrelated census', async () => {
  const run = fixture([{ unit: 1, book: 1 }, { unit: 2, book: 1 }], 7);
  expect(await run.read()).toMatchObject({ population: 8, total: 1 });
});

test('Maximum Book fanout uses only the bounded match and disclosure reads', async () => {
  const run = fixture(Array.from({ length: 512 }, (_, index) => ({ unit: 1, book: index + 1 })));
  expect(await run.read()).toMatchObject({ population: 512, total: 512 });
  expect(run.queries.length).toBeLessThanOrEqual(11);
});
