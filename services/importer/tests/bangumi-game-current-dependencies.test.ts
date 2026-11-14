import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  bangumiGameEnvironmentReferenceKey,
  createShowcaseBangumiGameEnvironmentLookup,
  mergeIdentifierResolutions,
  parseBangumiGameEnvironmentBindings,
} from '../src/showcase-bangumi-game-environment.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import type { ReviewedSubjectRead } from '../src/import-client.ts';

const pc = randomUUID();
const sourceUri = 'https://bgm.tv/info/platform/PC';
const binding = { kind: 'platform', item: 'PC', conceptId: pc, sourceUri } as const;
const reference = bangumiGameEnvironmentReferenceKey('schema:gamePlatform', 'PC');

function current(id = pc, url = sourceUri) {
  return {
    subject: {
      id,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ rank: 'normal', value: { type: 'value', content: url } }],
      },
    },
  } as unknown as ReviewedSubjectRead;
}

function withUrls(rows: unknown[]): ReviewedSubjectRead {
  return {
    subject: { ...current().subject, statements: { 'schema:url': rows } },
  } as unknown as ReviewedSubjectRead;
}

async function resolveGame(
  bindings: readonly (typeof binding | { kind: 'engine'; item: string; conceptId: string; sourceUri: string })[],
  available: { conceptId: string; sourceUri: string },
) {
  const lookup = createShowcaseBangumiGameEnvironmentLookup({
    sourceAlias: 'bangumi',
    bindings,
    read: async (id) => (id === available.conceptId ? current(id, available.sourceUri) : null),
  });
  const conversion = createSourceRegistration('bangumi').convert(
    {
      external_id: '1',
      record_revision: null,
      record: { id: 1, type: 4, name: 'Authored Game', infobox: '{{Infobox Game\n|平台=PC\n|游戏引擎=Unity\n}}' },
    },
    { source: 'bangumi' },
  );
  return lookup.resolve({
    owner: { source: 'bangumi', external_id: '1' },
    conversion,
    signal: new AbortController().signal,
  });
}

test('external Game environment profiles retain exact native lookup hints and reject ambiguous mappings', () => {
  expect(parseBangumiGameEnvironmentBindings([binding])).toEqual([binding]);
  for (const value of [
    null,
    {},
    [binding, binding],
    Array.from({ length: 25 }, () => binding),
    [{ ...binding, kind: 'genre' }],
    [{ ...binding, item: '' }],
    [{ ...binding, conceptId: 'PC' }],
    [{ ...binding, sourceUri: 'https://vndb.org/releases/platforms/win' }],
    [{ ...binding, sourceUri: 'http://bgm.tv/info/platform/PC' }],
  ])
    expect(() => parseBangumiGameEnvironmentBindings(value)).toThrow(TypeError);
});

test('one unavailable Game lookup preserves its properties and independently resolved references', () => {
  const genre = randomUUID();
  const genreRef = 'bangumi:game:genre:AVG';
  const unavailable = { status: 'unavailable' as const, preserveProperties: ['schema:gamePlatform', 'wdt:P408'] };
  expect(mergeIdentifierResolutions([{}, { [genreRef]: genre }, unavailable])).toEqual({
    ...unavailable,
    resolvedReferences: { [genreRef]: genre },
  });
  expect(
    mergeIdentifierResolutions([
      unavailable,
      {
        status: 'unavailable',
        preserveProperties: ['schema:genre'],
        resolvedReferences: { [reference]: pc },
      },
    ]),
  ).toEqual({
    status: 'unavailable',
    preserveProperties: ['schema:gamePlatform', 'wdt:P408', 'schema:genre'],
    resolvedReferences: { [reference]: pc },
  });
  expect(mergeIdentifierResolutions([{}, { [reference]: pc }])).toEqual({ [reference]: pc });
  expect(mergeIdentifierResolutions([])).toEqual({});
});

test('unavailable Game environment properties preserve independently current siblings in either direction', async () => {
  const engine = {
    kind: 'engine' as const,
    item: 'Unity',
    conceptId: randomUUID(),
    sourceUri: 'https://bgm.tv/info/engine/Unity',
  };
  for (const [available, unavailable, property, key] of [
    [binding, engine, 'wdt:P408', reference],
    [engine, binding, 'schema:gamePlatform', bangumiGameEnvironmentReferenceKey('wdt:P408', 'Unity')],
  ] as const) {
    expect(await resolveGame([available, unavailable], available)).toEqual({
      status: 'unavailable',
      preserveProperties: [property],
      resolvedReferences: { [key]: available.conceptId },
    });
  }
});

for (const scale of [1, 8, 64])
  test(`Game current dependency reads stay bounded at ${scale} selected records`, async () => {
    let reads = 0;
    const lookup = createShowcaseBangumiGameEnvironmentLookup({
      sourceAlias: 'bangumi',
      bindings: [binding],
      read: async (id) => {
        expect(id).toBe(pc);
        reads++;
        return current();
      },
    });
    const registration = createSourceRegistration('bangumi');
    const signal = new AbortController().signal;
    for (let id = 1; id <= scale; id++) {
      const conversion = registration.convert(
        {
          external_id: String(id),
          record_revision: null,
          record: { id, type: 4, name: 'Authored Game', infobox: '{{Infobox Game\n|平台=PC\n}}' },
        },
        { source: 'bangumi' },
      );
      const input = {
        owner: { source: 'bangumi', external_id: String(id) },
        conversion,
        signal,
      };
      expect(await lookup.resolve(input)).toEqual({ [reference]: pc });
    }
    expect(reads).toBe(1);
  });

test('unchanged Game source resolves a dependency again on the next seed pass', async () => {
  const conversion = createSourceRegistration('bangumi').convert(
    {
      external_id: '1',
      record_revision: null,
      record: { id: 1, type: 4, name: 'Authored Game', infobox: '{{Infobox Game\n|平台=PC\n}}' },
    },
    { source: 'bangumi' },
  );
  const input = { owner: { source: 'bangumi', external_id: '1' }, conversion, signal: new AbortController().signal };
  let page: ReviewedSubjectRead | null = null;
  const lookup = createShowcaseBangumiGameEnvironmentLookup({
    sourceAlias: 'bangumi',
    bindings: [binding],
    read: async () => page,
  });
  expect(mergeIdentifierResolutions([{}, await lookup.resolve(input)])).toEqual({
    status: 'unavailable',
    preserveProperties: ['schema:gamePlatform'],
  });
  const resolve = () => lookup.resolve({ ...input, signal: new AbortController().signal });
  page = current();
  expect(await resolve()).toEqual({ [reference]: pc });
  page = withUrls([{ rank: 'deprecated', value: { type: 'value', content: sourceUri } }]);
  expect(await resolve()).toEqual({});
  const source = { rank: 'preferred', value: { type: 'value', content: sourceUri } };
  const foreign = 'https://vndb.org/releases/platforms/win';
  page = withUrls([source, { rank: 'deprecated', value: { type: 'value', content: foreign } }]);
  expect(await resolve()).toEqual({ [reference]: pc });
  page = withUrls([source, { rank: 'normal', value: { type: 'value', content: foreign } }]);
  expect(await resolve()).toEqual({});
  page = withUrls([{ value: { type: 'value', content: sourceUri } }]);
  expect(await resolve()).toEqual({});
  page = withUrls([{ rank: 'normal', value: { type: 'some', content: sourceUri } }]);
  expect(await resolve()).toEqual({});
  page = { subject: { id: pc, type: 'skos:Concept', statements: {} } } as unknown as ReviewedSubjectRead;
  expect(await resolve()).toEqual({});
});
