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

function current() {
  return {
    subject: {
      id: pc,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: sourceUri } }],
      },
    },
  } as unknown as ReviewedSubjectRead;
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
        signal: new AbortController().signal,
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
  const first = createShowcaseBangumiGameEnvironmentLookup({
    sourceAlias: 'bangumi',
    bindings: [binding],
    read: async () => null,
  });
  expect(mergeIdentifierResolutions([{}, await first.resolve(input)])).toEqual({
    status: 'unavailable',
    preserveProperties: ['schema:gamePlatform', 'wdt:P408'],
  });
  const next = createShowcaseBangumiGameEnvironmentLookup({
    sourceAlias: 'bangumi',
    bindings: [binding],
    read: async () => current(),
  });
  expect(await next.resolve(input)).toEqual({ [reference]: pc });
});
