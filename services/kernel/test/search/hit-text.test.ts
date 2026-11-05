import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import type { PublicFigureView } from '../../src/rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createFakeSource } from './support/fake-source.ts';

const missingFigure: PublicFigureView = {
  questionId: STANDARD_QUESTION_ID,
  populationId: GLOBAL_CONTEXT.id,
  scale: { min: 0, max: 20, displayStep: 1 },
  count: 0,
  state: 'insufficient_data',
  mean: null,
  score: null,
};

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const client = createOpenSearch(searchUrl);
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;

const id = (n: number) => `018f0000-0000-7000-8000-00b0${String(n).padStart(8, '0')}`;
const texts = (values: Record<string, string>) =>
  Object.entries(values).map(([language, value]) => ({ language, value }));
const subject = (
  n: number,
  type: string,
  labels: Record<string, string>,
  descriptions: Record<string, string> = {},
): IndexedSubject => ({
  id: id(n),
  type,
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: texts(labels),
  aliases: [],
  descriptions: texts(descriptions),
  statements: [],
});

const utopia = 'An ambiguous utopia on two worlds. '.repeat(8);
const utopiaCut = `${'An ambiguous utopia on two worlds. '.repeat(5)}An ambiguous utopia on t…`;
const accent = 'é';
const family = '\u{1F469}‍\u{1F469}‍\u{1F467}';
const subjects = [
  subject(
    1,
    'schema:Book',
    { en: 'The Dispossessed', ja: '所有せざる人々' },
    { en: utopia, ja: 'アナレスとウラスの物語。' },
  ),
  subject(2, 'schema:Book', { en: 'The Dispossessed' }, { en: 'A study edition with notes.' }),
  subject(
    3,
    'schema:Person',
    { en: 'Ursula K. Le Guin', ja: 'アーシュラ・K・ル＝グウィン' },
    { en: 'American author (1929–2018).' },
  ),
  subject(20, 'schema:Note', { en: 'Note A' }, { en: accent.repeat(120) + family.repeat(130) }),
  subject(21, 'schema:Note', { en: 'Note B' }, { en: 'x'.repeat(200) }),
  subject(22, 'schema:Note', { en: 'Note C' }, { en: `${'a'.repeat(198)} ${'b'.repeat(10)}` }),
  subject(23, 'schema:Note', { en: 'Note D' }, { en: 'y'.repeat(201) }),
  subject(30, 'schema:Unlisted', { en: 'Unlisted thing' }),
  subject(
    40,
    'schema:Article',
    { 'zh-Hant': '繁體標籤', en: 'English label' },
    {
      'zh-Hant': '繁體描述',
      en: 'English description',
    },
  ),
  {
    ...subject(
      41,
      'schema:CreativeWork',
      { ja: '原語の作品', en: 'Original work' },
      {
        ja: '原語の説明',
        en: 'Original description',
      },
    ),
    statements: [{ property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' as const } }],
  },
  subject(
    42,
    'schema:CreativeWork',
    { ja: '原語の作品', en: 'Original work' },
    {
      ja: '原語の説明',
      en: 'Original description',
    },
  ),
  subject(43, 'schema:CreativeWork', { ja: '作品', fr: 'Œuvre' }, { ja: '説明', fr: 'Description' }),
  subject(44, 'schema:CreativeWork', {}),
];
const release = {
  types: {
    'schema:Book': { bases: [], facets: [] },
    'schema:Person': { bases: [], facets: [] },
    'schema:Note': { bases: [], facets: [] },
    'schema:Article': { bases: [], facets: [] },
    'schema:CreativeWork': { bases: [], facets: [] },
  },
  properties: {},
};
const fake = createFakeSource();
let reads = 0;
const source = {
  ...fake,
  read(...args: Parameters<typeof fake.read>) {
    reads++;
    return fake.read(...args);
  },
};
const service = createSearchService({ pool, client, prefix, source, cursors, release: async () => release });
const index = subjectIndexName(prefix, 1);
const people = { type: { in: ['schema:Book', 'schema:Person'] } };
const notes = { type: { in: ['schema:Note'] } };

beforeAll(async () => {
  await createSubjectIndex(client, prefix, 1);
  for (const entry of subjects) fake.put(entry);
  const ids = subjects.map((entry) => entry.id);
  const snapshot = await fake.read(subjectPartition(id(1)), ids);
  await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProblemError);
  return [(error as ProblemError).code, (error as ProblemError).errors] as unknown[];
}

const described = (hit: object) => (hit as { descriptions?: Record<string, string> }).descriptions;

test('search hits carry their descriptions only on request', async () => {
  const before = reads;
  const answer = await service.search('anonymous', { filter: people, sort: 'name', descriptions: true });
  expect(answer.subjects).toEqual([
    {
      figure: missingFigure,
      id: id(1),
      type: 'schema:Book',
      labels: { en: 'The Dispossessed', ja: '所有せざる人々' },
      descriptions: { en: utopiaCut, ja: 'アナレスとウラスの物語。' },
    },
    {
      figure: missingFigure,
      id: id(2),
      type: 'schema:Book',
      labels: { en: 'The Dispossessed' },
      descriptions: { en: 'A study edition with notes.' },
    },
    {
      figure: missingFigure,
      id: id(3),
      type: 'schema:Person',
      labels: { en: 'Ursula K. Le Guin', ja: 'アーシュラ・K・ル＝グウィン' },
      descriptions: { en: 'American author (1929–2018).' },
    },
  ]);
  expect(reads - before).toBe(1);

  const plain = await service.search('anonymous', { filter: people, sort: 'name' });
  expect(plain.subjects).toEqual([
    { figure: missingFigure, id: id(1), type: 'schema:Book', labels: { en: 'The Dispossessed', ja: '所有せざる人々' } },
    { figure: missingFigure, id: id(2), type: 'schema:Book', labels: { en: 'The Dispossessed' } },
    {
      figure: missingFigure,
      id: id(3),
      type: 'schema:Person',
      labels: { en: 'Ursula K. Le Guin', ja: 'アーシュラ・K・ル＝グウィン' },
    },
  ]);
  expect((await service.search('anonymous', { filter: people, sort: 'name', descriptions: false })).subjects).toEqual(
    plain.subjects,
  );
});

test('descriptions are cut to 200 grapheme clusters and end with an ellipsis', async () => {
  const answer = await service.search('anonymous', { filter: notes, sort: 'name', descriptions: true });
  expect(answer.subjects.map((hit) => described(hit)?.en)).toEqual([
    `${accent.repeat(120)}${family.repeat(79)}…`,
    'x'.repeat(200),
    `${'a'.repeat(198)}…`,
    `${'y'.repeat(199)}…`,
  ]);
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const hit of answer.subjects)
    expect([...graphemes.segment(described(hit)?.en ?? '')].length).toBeLessThanOrEqual(200);
});

test('a language chain chooses one label and one description per hit', async () => {
  for (const languages of [['zh-Hans', 'zh', 'zh-Hant', 'en'], ['zh-TW'], ['en']]) {
    const before = reads;
    const answer = await service.search('anonymous', {
      filter: { type: { in: ['schema:Article'] } },
      descriptions: true,
      languages,
    });
    const language = languages[0] === 'en' ? 'en' : 'zh-Hant';
    expect(answer.subjects).toEqual([
      {
        figure: missingFigure,
        id: id(40),
        type: 'schema:Article',
        labels: { [language]: language === 'en' ? 'English label' : '繁體標籤' },
        descriptions: { [language]: language === 'en' ? 'English description' : '繁體描述' },
      },
    ]);
    expect(reads - before).toBe(1);
  }

  const japanese = await service.search('anonymous', {
    filter: people,
    sort: 'name',
    descriptions: true,
    languages: ['ja'],
  });
  expect(japanese.subjects.map((hit) => [hit.id, hit.labels, described(hit)])).toEqual([
    [id(1), { ja: '所有せざる人々' }, { ja: 'アナレスとウラスの物語。' }],
    [id(2), { en: 'The Dispossessed' }, { en: 'A study edition with notes.' }],
    [id(3), { ja: 'アーシュラ・K・ル＝グウィン' }, { en: 'American author (1929–2018).' }],
  ]);

  const both = await service.search('anonymous', {
    filter: people,
    sort: 'name',
    descriptions: true,
    languages: ['ja', 'en'],
  });
  expect(both.subjects.map((hit) => [hit.labels, described(hit)])).toEqual([
    [{ ja: '所有せざる人々' }, { ja: 'アナレスとウラスの物語。' }],
    [{ en: 'The Dispossessed' }, { en: 'A study edition with notes.' }],
    [{ ja: 'アーシュラ・K・ル＝グウィン' }, { en: 'American author (1929–2018).' }],
  ]);

  const englishFirst = await service.search('anonymous', {
    filter: people,
    sort: 'name',
    descriptions: true,
    languages: ['en', 'ja'],
  });
  expect(englishFirst.subjects.map((hit) => [hit.labels, described(hit)])).toEqual([
    [{ en: 'The Dispossessed' }, { en: utopiaCut }],
    [{ en: 'The Dispossessed' }, { en: 'A study edition with notes.' }],
    [{ en: 'Ursula K. Le Guin' }, { en: 'American author (1929–2018).' }],
  ]);

  const labelsOnly = await service.search('anonymous', { filter: people, sort: 'name', languages: ['ja'] });
  expect(labelsOnly.subjects.map((hit) => [hit.labels, 'descriptions' in hit])).toEqual([
    [{ ja: '所有せざる人々' }, false],
    [{ en: 'The Dispossessed' }, false],
    [{ ja: 'アーシュラ・K・ル＝グウィン' }, false],
  ]);
});

test('a hit falls back to its original language, then English, then its first label', async () => {
  const answer = await service.search('anonymous', {
    filter: { type: { in: ['schema:CreativeWork'] } },
    sort: 'id',
    descriptions: true,
    languages: ['ko'],
  });
  expect(answer.subjects.map((hit) => [hit.id, hit.labels, described(hit)])).toEqual([
    [id(41), { ja: '原語の作品' }, { ja: '原語の説明' }],
    [id(42), { en: 'Original work' }, { en: 'Original description' }],
    [id(43), { fr: 'Œuvre' }, { fr: 'Description' }],
    [id(44), {}, {}],
  ]);
});

test('languages and descriptions are validated', async () => {
  const search = (fields: Record<string, unknown>) =>
    service.search('anonymous', { filter: people, ...fields } as never);
  const invalid = (pointer: string, code: string) => ['invalid_request', [{ pointer, code }]];
  expect(await refusal(search({ descriptions: 'yes' }))).toEqual(invalid('/descriptions', 'invalid_type'));
  expect(await refusal(search({ languages: 'en' }))).toEqual(invalid('/languages', 'invalid_type'));
  expect(await refusal(search({ languages: [] }))).toEqual(invalid('/languages', 'out_of_range'));
  expect(await refusal(search({ languages: ['en', 'ja', 'fr', 'de', 'es', 'it', 'ko', 'pt', 'ru'] }))).toEqual(
    invalid('/languages', 'out_of_range'),
  );
  expect(await refusal(search({ languages: [7] }))).toEqual(invalid('/languages/0', 'invalid_type'));
  expect(await refusal(search({ languages: ['en', 'en'] }))).toEqual(invalid('/languages/1', 'invalid_format'));
  for (const tag of ['en_US', 'e', 'en-', `en-${'a'.repeat(9)}`, ['en', ...Array(5).fill('abcdefg')].join('-')])
    expect(await refusal(search({ languages: [tag] }))).toEqual(invalid('/languages/0', 'invalid_format'));
  const accepted = await search({ languages: ['zh-Hant', 'en-GB', 'yue'], descriptions: false });
  expect(accepted.subjects).toHaveLength(3);
});

test('a subject without descriptions carries an empty map, and descriptions need no active release', async () => {
  const unlisted = await service.search('anonymous', { text: 'Unlisted', descriptions: true });
  expect(unlisted.subjects).toEqual([
    { figure: missingFigure, id: id(30), type: 'schema:Unlisted', labels: { en: 'Unlisted thing' }, descriptions: {} },
  ]);

  const bare = createSearchService({ pool, client, prefix, source, cursors, release: async () => null });
  const answer = await bare.search('anonymous', { text: 'Dispossessed', descriptions: true, languages: ['en'] });
  expect([...answer.subjects].sort((a, b) => (a.id < b.id ? -1 : 1)).map((hit) => [hit.id, described(hit)])).toEqual([
    [id(1), { en: utopiaCut }],
    [id(2), { en: 'A study edition with notes.' }],
  ]);
});

test('languages and descriptions join the cursor binding', async () => {
  const request = { filter: people, sort: 'name' as const, limit: 1, languages: ['en'] };
  const first = await service.search('anonymous', request);
  expect(first.subjects.map((hit) => hit.id)).toEqual([id(1)]);
  expect(first.next).not.toBeNull();
  const second = await service.search('anonymous', { ...request, cursor: first.next! });
  expect(second.subjects.map((hit) => hit.id)).toEqual([id(2)]);
  for (const changed of [{ languages: ['ja'] }, { descriptions: true }])
    expect(await refusal(service.search('anonymous', { ...request, ...changed, cursor: first.next! }))).toEqual([
      'invalid_request',
      [{ pointer: '/cursor', code: 'invalid_format' }],
    ]);
});
