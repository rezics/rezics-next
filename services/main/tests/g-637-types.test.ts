import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import {
  typeBases,
  typeLocales,
  typeRegistry,
} from '../../../packages/model/src/generated/types.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { baselineWorkTypesAllowed } from '../src/modules/access/baseline.ts';
import { workTypeFilters } from '../src/api-contract.ts';
import { choiceTypes, primaryType } from '../src/modules/onboarding/choices.ts';
import { discoveryType } from '../src/modules/discovery/contract.ts';
import { TYPES_READ_COST, typeList } from '../src/modules/types/contract.ts';
import {
  creatableWorkTypeOptions,
  choiceWorkTypeOptions,
  typeListBody,
  workSemanticTypeOptions,
} from '../src/modules/types/registry.ts';
import { metadataWorkRequestDigest, WORK_SEMANTIC_TYPES } from '../src/modules/work/activate.ts';
import {
  checkedWorkTypes,
  WORK_TYPE_OPTIONS,
  WORK_TYPE_OPTIONS_V1,
} from '../src/modules/work/type-schema.ts';
import { workKinds, workSemanticTypes } from '../src/modules/work/work-kinds.ts';
import { openApiOperations } from '../src/routes/types.ts';

// No server or owner answers are available: this read must be wholly compiled.
const app = createMainApp(
  new FusekiClient('http://127.0.0.1:1/rezics'),
  {} as MainWorkDependencies,
);
const get = (headers: Record<string, string> = {}) =>
  app.handle(new Request('http://main.local/v1/types', { headers }));

test('G-637: public GET /v1/types serves every admitted type once with defaults and all eight locale forms', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  const body = (await response.json()) as Static<typeof typeList>;
  expect(Value.Check(typeList, body)).toBe(true);
  expect(body.profile).toBe('types-v1');
  expect(response.headers.get('etag')).toBe(`"${body.digest}"`);
  expect(body.types).toEqual(Object.values(typeRegistry));
  expect(new Set(body.types.map((entry) => entry.type)).size).toBe(body.types.length);
  expect(
    body.types
      .filter((entry) => entry.base === 'work')
      .map((entry) => entry.type)
      .sort(),
  ).toEqual([...historicalTypes, 'https://schema.org/CreativeWork'].sort());
  for (const entry of body.types) {
    for (const locale of typeLocales) {
      expect(entry.labels[locale].one.length).toBeGreaterThan(0);
      expect(entry.labels[locale].other.length).toBeGreaterThan(0);
    }
  }
  for (const base of typeBases)
    expect(body.types.filter((entry) => entry.base === base && entry.default)).toHaveLength(1);
  expect(openApiOperations['/v1/types'].get.bearer).toBe(false);
});

test('G-637: onboarding derives every Work kind in its existing presentation precedence', () => {
  expect(choiceTypes).toBe(choiceWorkTypeOptions);
  expect(choiceTypes as string[]).toEqual([
    'https://rezics.com/vocab/ModPackage',
    'https://rezics.com/vocab/SkillPackage',
    'https://rezics.com/vocab/PromptTemplate',
    'https://schema.org/Recipe',
    'https://schema.org/VideoGame',
    'https://schema.org/Book',
    'https://schema.org/BookSeries',
    'https://schema.org/SoftwareApplication',
    'https://schema.org/SoftwareSourceCode',
    'https://schema.org/Movie',
    'https://schema.org/TVSeries',
    'https://schema.org/VideoObject',
    'https://schema.org/MusicAlbum',
    'https://schema.org/MusicRecording',
    'https://schema.org/AudioObject',
    'https://schema.org/DigitalDocument',
  ]);
  expect([...choiceTypes].sort()).toEqual([...workSemanticTypeOptions].sort());
  expect(
    primaryType(['https://schema.org/SoftwareApplication', 'https://rezics.com/vocab/ModPackage']),
  ).toBe('https://rezics.com/vocab/ModPackage');
  expect(primaryType(['https://schema.org/Book', 'https://schema.org/VideoGame'])).toBe(
    'https://schema.org/VideoGame',
  );
});

test('G-637: search include and exclude filters admit the full registry Work set within existing bounds', () => {
  for (const filter of [workTypeFilters.includeTypes, workTypeFilters.excludeTypes]) {
    for (const type of workSemanticTypeOptions) expect(Value.Check(filter, [type])).toBe(true);
    for (const type of Object.values(typeRegistry).filter(
      (entry) => entry.default || entry.base !== 'work',
    )) {
      expect(Value.Check(filter, [type.type])).toBe(false);
    }
    expect(Value.Check(filter, [])).toBe(true);
    expect(Value.Check(filter, ['https://schema.org/Unknown'])).toBe(false);
    expect(Value.Check(filter, [workSemanticTypeOptions[0], workSemanticTypeOptions[0]])).toBe(
      false,
    );
    expect(Value.Check(filter, workSemanticTypeOptions.slice(0, 4))).toBe(false);
  }
});

test('G-637: conditional reads return an empty 304 for matching, weak, wildcard or list ETags', async () => {
  const tag = (await get()).headers.get('etag')!;
  for (const header of [tag, `W/${tag}`, '*', `"other", W/${tag}`]) {
    const response = await get({ 'if-none-match': header });
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(tag);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await response.text()).toBe('');
  }
  for (const header of ['"stale"', '', `"${tag.slice(1, -1)}-other"`]) {
    const response = await get({ 'if-none-match': header });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(typeListBody);
  }
});

test('G-637: read cost is one startup-bounded body with no graph access, independent of reader', async () => {
  expect(TYPES_READ_COST.graphReads).toBe(0);
  expect(Object.keys(typeRegistry).length).toBeLessThanOrEqual(TYPES_READ_COST.maxTypes);
  expect(Buffer.byteLength(typeListBody)).toBeLessThanOrEqual(TYPES_READ_COST.maxBytes);
  const first = await get();
  const other = await get({
    authorization: 'Bearer ignored-for-public-read',
    'accept-language': 'ja',
  });
  expect(await other.text()).toBe(await first.text());
  expect(other.headers.get('etag')).toBe(first.headers.get('etag'));
});

const historicalTypes = [
  'https://schema.org/Book',
  'https://schema.org/BookSeries',
  'https://schema.org/DigitalDocument',
  'https://schema.org/Recipe',
  'https://schema.org/SoftwareApplication',
  'https://schema.org/SoftwareSourceCode',
  'https://schema.org/VideoGame',
  'https://rezics.com/vocab/ModPackage',
  'https://rezics.com/vocab/SkillPackage',
  'https://rezics.com/vocab/PromptTemplate',
  'https://schema.org/Movie',
  'https://schema.org/TVSeries',
  'https://schema.org/VideoObject',
  'https://schema.org/AudioObject',
  'https://schema.org/MusicRecording',
  'https://schema.org/MusicAlbum',
];
const historicalEditTypes = [
  'https://schema.org/Book',
  'https://schema.org/DigitalDocument',
  'https://schema.org/Recipe',
  'https://schema.org/SoftwareApplication',
  'https://schema.org/SoftwareSourceCode',
  'https://schema.org/VideoGame',
  'https://rezics.com/vocab/ModPackage',
  'https://rezics.com/vocab/SkillPackage',
  'https://rezics.com/vocab/PromptTemplate',
];

test('G-637: create, discovery and type-edit enums retain their complete original sets and ordering', () => {
  expect(workSemanticTypes as string[]).toEqual(historicalTypes);
  expect(workSemanticTypeOptions).toBe(workSemanticTypes);
  expect(WORK_SEMANTIC_TYPES).toBe(workSemanticTypes);
  expect(Object.keys(workKinds)).toEqual(historicalTypes);
  expect(WORK_TYPE_OPTIONS as string[]).toEqual(historicalEditTypes);
  expect(WORK_TYPE_OPTIONS).toBe(creatableWorkTypeOptions);
  expect(WORK_TYPE_OPTIONS_V1 as string[]).toEqual(
    historicalEditTypes.filter((type) => type !== 'https://schema.org/VideoGame'),
  );
  expect([...WORK_TYPE_OPTIONS].sort() as string[]).toEqual(
    Object.values(typeRegistry)
      .filter((entry) => entry.creatable)
      .map((entry) => entry.type)
      .sort(),
  );
  for (const type of historicalTypes) {
    expect(metadataWorkRequestDigest('Example', [type])).toMatch(/^[a-f0-9]{64}$/);
    expect(Value.Check(discoveryType, type)).toBe(true);
    if (historicalEditTypes.includes(type)) expect(checkedWorkTypes([type])).toEqual([type]);
    else expect(() => checkedWorkTypes([type])).toThrow();
  }
  for (const type of [
    'https://schema.org/CreativeWork',
    'https://rezics.com/vocab/Character',
    'https://rezics.com/vocab/Record',
    'https://rezics.com/vocab/WebNovel',
    'https://schema.org/Unknown',
  ]) {
    expect(() => metadataWorkRequestDigest('Example', [type])).toThrow();
    expect(() => checkedWorkTypes([type])).toThrow();
    expect(Value.Check(discoveryType, type)).toBe(false);
  }
});

test('G-637: generated public API retains old type-edit enums beside the open v3 request', () => {
  type BodySchema = {
    properties: {
      semanticTypes?: { items: { enum?: string[]; type?: string; format?: string } };
      profile?: { const: string };
      types?: { items: { enum?: string[]; type?: string; pattern?: string } };
    };
    anyOf?: BodySchema[];
  };
  type Operation = { requestBody: { content: { 'application/json': { schema: BodySchema } } } };
  const api = JSON.parse(
    readFileSync(new URL('../../../generated/openapi/main/public.json', import.meta.url), 'utf8'),
  ) as {
    paths: { '/v1/works': { post: Operation }; '/v1/works/{id}/type': { put: Operation } };
  };
  const create = api.paths['/v1/works'].post.requestBody.content['application/json'].schema;
  const creates = create.anyOf!;
  expect(creates).toHaveLength(2);
  for (const body of creates) {
    expect(body.properties.semanticTypes!.items.type).toBe('string');
    expect(body.properties.semanticTypes!.items.enum).toBeUndefined();
    expect(body.properties.semanticTypes!.items.format).toBe('rezics-work-type');
  }
  const edits =
    api.paths['/v1/works/{id}/type'].put.requestBody.content['application/json'].schema.anyOf!;
  expect(edits).toHaveLength(3);
  for (const edit of edits) {
    if (edit.properties.profile!.const === 'work-type-v3') {
      expect(edit.properties.types!.items.type).toBe('string');
      expect(edit.properties.types!.items.enum).toBeUndefined();
      expect(edit.properties.types!.items.pattern).toBeDefined();
      continue;
    }
    const expected =
      edit.properties.profile!.const === 'work-type-v1'
        ? historicalEditTypes.filter((type) => type !== 'https://schema.org/VideoGame')
        : historicalEditTypes;
    expect(edit.properties.types!.items.enum).toEqual(expected);
  }
});

test('G-637: the existing interests, primary actions and G-508 creation authority remain exact', () => {
  const expected = [
    ['Book', 'books', 'read', 'contributor'],
    ['BookSeries', 'books', 'read', 'contributor'],
    ['DigitalDocument', null, 'read', 'contributor'],
    ['Recipe', 'recipes', 'read', 'contributor'],
    ['SoftwareApplication', 'software', 'install', 'administrator'],
    ['SoftwareSourceCode', 'software', 'install', 'administrator'],
    ['VideoGame', 'media', 'visit', 'contributor'],
    ['ModPackage', 'software', 'install', 'administrator'],
    ['SkillPackage', 'ai', 'install', 'contributor'],
    ['PromptTemplate', 'ai', 'copy', 'contributor'],
    ['Movie', 'media', 'watch', 'contributor'],
    ['TVSeries', 'media', 'watch', 'contributor'],
    ['VideoObject', 'media', 'watch', 'contributor'],
    ['AudioObject', 'media', 'watch', 'contributor'],
    ['MusicRecording', 'media', 'watch', 'contributor'],
    ['MusicAlbum', 'media', 'watch', 'contributor'],
  ] as const;
  for (const [name, interest, primaryAction, creation] of expected) {
    const prefix = ['ModPackage', 'SkillPackage', 'PromptTemplate'].includes(name)
      ? 'https://rezics.com/vocab/'
      : 'https://schema.org/';
    const type = `${prefix}${name}` as keyof typeof workKinds;
    expect(
      workKinds[type] as { interest: string | null; primaryAction: string; creation: string },
    ).toEqual({ interest, primaryAction, creation });
    expect(baselineWorkTypesAllowed({ workSemanticTypes: [type] })).toBe(
      creation === 'contributor',
    );
  }
});

test('G-637: registry derivation preserves invalid and conflicting type combinations', () => {
  expect(checkedWorkTypes([])).toEqual([]);
  for (const types of [
    ['https://schema.org/Book', 'https://schema.org/Book'],
    ['https://schema.org/Book', 'https://schema.org/Recipe'],
    ['https://rezics.com/vocab/SkillPackage', 'https://rezics.com/vocab/PromptTemplate'],
    historicalTypes.slice(0, 4),
  ]) {
    expect(() => metadataWorkRequestDigest('Example', types)).toThrow();
    expect(() => checkedWorkTypes(types)).toThrow();
  }
});
