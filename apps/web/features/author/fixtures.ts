import type { AuthorFollowState, AuthorWork, AuthorWorksPage, ExternalAuthor, Loaded } from './types.ts';

// Story data shaped as Main answers `/v1/authors/open-library/{id}`, drawn
// from the locked Open Library records the demo seed imports.

export const storyId = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-7c1d-4e2f-9a3b-5c6d7e8f9a0b`;
const position = { dataEpoch: 'story', sequence: '42' };
const name = (value: string, language: string) => ({ value, language, direction: 'ltr' as const,
  basis: 'requested' as const });
const cover = (n: number) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', key: `work-${n}`,
  resourceType: 'work' });
const rating = (mean: number, count: number) => ({ context: storyId(500), count, sum: Math.round(mean * count), mean,
  scale: { min: 1 as const, max: 5 as const } });
const source = <Field extends string>(id: string, field: Field) => ({ record: storyId(700), observation: storyId(701),
  revision: storyId(702), sourceRevision: 'open-library-revision:77', digest: '0'.repeat(64),
  url: `https://openlibrary.org/authors/${id}.json`, fetchedAt: '2026-09-28T02:06:30.948Z',
  basis: 'facts' as const, field });
const external = (key: string, displayName: string | null) =>
  ({ kind: 'external' as const, provider: 'open-library' as const, key, displayName });
const book = ['https://schema.org/Book'];
const document = ['https://schema.org/DigitalDocument'];

function work(n: number, title: string, language: string, authors: AuthorWork['authors'],
  extra: Partial<AuthorWork> = {}): AuthorWork {
  return { id: storyId(100 + n), title: name(title, language), cover: cover(n), types: book, tagline: null,
    completionStatus: null, rating: null, authors, ...extra };
}

type Facts = NonNullable<ExternalAuthor['facts']>;
function author(id: string, displayName: string | null, facts: Facts | null, items: AuthorWork[],
  totals: ExternalAuthor['totals'], nextCursor: string | null = null): ExternalAuthor {
  const key = `/authors/${id}`;
  return { profile: 'external-author-read-v1', provider: 'open-library', key,
    name: displayName === null ? null : { displayName, nameSource: source(id, '/name' as const) },
    facts, record: `https://openlibrary.org${key}`, totals, works: { items, nextCursor }, sourcePosition: position,
    links: { page: `/authors/open-library/${id}`, works: `/v1/authors/open-library/${id}/works` } };
}

const date = (id: string, field: '/birth_date' | '/death_date', text: string, year: number | null,
  month: number | null = null, day: number | null = null, approximate = false) =>
  ({ text, year, month, day, approximate, source: source(id, field) });
const identifier = (id: string, scheme: Facts['identifiers'][number]['scheme'], value: string, url: string) =>
  ({ scheme, value, url, source: source(id, `/remote_ids/${scheme}` as const) });

const austen = '/authors/OL21594A';
/** Jane Austen as the demo imports her: two Works, one co-written, rated and read. */
export const janeAusten = author('OL21594A', 'Jane Austen', {
  birthDate: date('OL21594A', '/birth_date', 'December 16, 1775', 1775, 12, 16),
  deathDate: date('OL21594A', '/death_date', 'July 18, 1817', 1817, 7, 18),
  fullerName: null,
  identifiers: [
    identifier('OL21594A', 'project_gutenberg', '68', 'https://www.gutenberg.org/ebooks/author/68'),
    identifier('OL21594A', 'librivox', '155', 'https://librivox.org/author/155'),
    identifier('OL21594A', 'wikidata', 'Q36322', 'https://www.wikidata.org/wiki/Q36322'),
    identifier('OL21594A', 'lc_naf', 'n79032879', 'https://id.loc.gov/authorities/names/n79032879.html'),
    identifier('OL21594A', 'viaf', '102333412', 'https://viaf.org/viaf/102333412'),
    identifier('OL21594A', 'isni', '000000012283635X', 'https://isni.org/isni/000000012283635X'),
  ],
}, [
  work(1, 'Pride and Prejudice', 'en', [external(austen, 'Jane Austen')], { rating: rating(3.71, 7),
    tagline: name('A spirited young woman, a proud gentleman, and first impressions that will not hold.', 'en') }),
  work(2, 'Lady Susan / The Watsons / Sanditon', 'en', [external(austen, 'Jane Austen'),
    external('/authors/OL1234567A', 'Margaret Drabble')], { rating: rating(4, 1) }),
], { works: { value: 2, kind: 'exact' },
  ratings: { context: storyId(500), count: { value: 8, kind: 'exact' }, mean: 3.75, scale: { min: 1, max: 5 } },
  readers: { value: 1, kind: 'exact' } });

/** Arthur Conan Doyle: two Works, nobody has rated or finished them yet. */
export const conanDoyle = author('OL161167A', 'Arthur Conan Doyle', {
  birthDate: date('OL161167A', '/birth_date', '1859-05-22', 1859, 5, 22),
  deathDate: date('OL161167A', '/death_date', '1930-07-07', 1930, 7, 7),
  fullerName: null,
  identifiers: [
    identifier('OL161167A', 'project_gutenberg', '69', 'https://www.gutenberg.org/ebooks/author/69'),
    identifier('OL161167A', 'wikidata', 'Q35610', 'https://www.wikidata.org/wiki/Q35610'),
  ],
}, [
  work(3, 'The Adventures of Sherlock Holmes [12 stories]', 'en', [external('/authors/OL161167A', 'Arthur Conan Doyle')]),
  work(4, 'A Scandal in Bohemia', 'en', [external('/authors/OL161167A', 'Arthur Conan Doyle')], { types: document }),
], { works: { value: 2, kind: 'exact' }, ratings: null, readers: { value: 0, kind: 'exact' } });

/** Cao Xueqin: an approximate birth year, a Work written with Gao E, a Chinese title. */
export const caoXueqin = author('OL15030763A', '曹雪芹', {
  birthDate: date('OL15030763A', '/birth_date', 'approximately 1717', 1717, null, null, true),
  deathDate: date('OL15030763A', '/death_date', '1763', 1763),
  fullerName: null, identifiers: [],
}, [work(5, '红楼梦', 'zh-Hans', [external('/authors/OL15030763A', '曹雪芹'), external('/authors/OL15811481A', '高鹗')],
  { rating: rating(4.5, 2), tagline: name('大观园里的繁华与散场。', 'zh-Hans') })],
{ works: { value: 1, kind: 'exact' },
  ratings: { context: storyId(500), count: { value: 2, kind: 'exact' }, mean: 4.5, scale: { min: 1, max: 5 } },
  readers: { value: 0, kind: 'exact' } });

/** Lewis Carroll: a fuller name, a date Open Library wrote in a form the page keeps as written. */
export const lewisCarroll = author('OL22098A', 'Lewis Carroll', {
  birthDate: date('OL22098A', '/birth_date', 'January 27, 1832', 1832, 1, 27),
  deathDate: date('OL22098A', '/death_date', 'winter of 1898', null),
  fullerName: { value: 'Charles Lutwidge Dodgson', source: source('OL22098A', '/fuller_name' as const) },
  identifiers: [identifier('OL22098A', 'wikidata', 'Q38082', 'https://www.wikidata.org/wiki/Q38082')],
}, [work(6, 'Alice’s Adventures in Wonderland', 'en', [external('/authors/OL22098A', 'Lewis Carroll')],
  { rating: rating(3.25, 4) })],
{ works: { value: 1, kind: 'exact' },
  ratings: { context: storyId(500), count: { value: 4, kind: 'exact' }, mean: 3.25, scale: { min: 1, max: 5 } },
  readers: null });

/** An author REZICS has not named yet: the page uses their Open Library ID and shows no facts. */
export const unnamedAuthor = author('OL15669783A', null, null,
  [work(7, '聊斋志异', 'zh-Hans', [external('/authors/OL68149A', 'Pu Songling'), external('/authors/OL15669783A', null)])],
  { works: { value: 1, kind: 'exact' }, ratings: null, readers: { value: 0, kind: 'exact' } });

/** A prolific author: more Works than the overview shows, and counts past Main's probe. */
export const prolificAuthor = author('OL21594A', 'Jane Austen', janeAusten.facts,
  Array.from({ length: 10 }, (_, index) => work(20 + index, `Collected edition ${index + 1}`, 'en',
    [external(austen, 'Jane Austen')], { rating: rating(4 - index / 10, 900 - index * 70) })),
  { works: { value: 64, kind: 'lower-bound' },
    ratings: { context: storyId(500), count: { value: 41_875, kind: 'lower-bound' }, mean: 4.18,
      scale: { min: 1, max: 5 } },
    readers: { value: 10_000, kind: 'lower-bound' } }, 'story-next');

export const austenWorksPage: AuthorWorksPage = { items: prolificAuthor.works.items, nextCursor: 'story-next',
  sourcePosition: position, count: { value: 10, kind: 'exact-page', total: null } };

/**
 * Main's follow read for an author: everyone's count, and the reader's own
 * follow when signed in (`following` null signed out).
 */
export function authorFollow(author: ExternalAuthor, followers: number, following: boolean | null = null,
  kind: 'exact' | 'lower-bound' = 'exact'): Loaded<AuthorFollowState> {
  const id = author.key.slice('/authors/'.length);
  return { ok: true, data: { profile: 'follow-state-v1', following,
    revision: following ? '0192e0aa-0000-7000-8000-000000000001' : null,
    target: { id: `open-library:${id}`, kind: 'external-author',
      name: { value: author.name?.displayName ?? id, language: 'und', direction: 'ltr', basis: 'fallback' },
      icon: { kind: 'fallback', policy: 'avatar-fallback-v1', key: `open-library:${id}`, resourceType: 'agent' },
      realm: null, href: `/authors/open-library/${id}` },
    followers: { value: followers, kind } } };
}
