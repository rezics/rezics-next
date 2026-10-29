import { expect, test } from 'bun:test';
import { slug } from '@rezics/definitions/slug';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { fromMarkdown } from '@rezics/document';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { RatingsContext } from '../src/features/pages/subject-ratings-view.tsx';
import { GLOBAL } from '../src/features/pages/subject-ratings.ts';

const subjectId = '01a1740d-7480-71e4-841f-66c04022d7d0';
const characterId = '01a1740d-7480-71e4-841f-66c04022d7c0';
const roleId = '01a1740d-7480-71e4-841f-66c04022d7b0';
const mediaId = '01a1740d-7480-71e4-841f-66c04022d7e0';
const context = '00000000-0000-8000-8000-000000000000';
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const value = (content: unknown) => ({ type: 'value', content });

const cover = {
  media: mediaId,
  width: 800,
  height: 1200,
  placeholder: { thumbhash: '3PcNNYSFeXh/b3eQa1p4iHaQeYD3/3gAAA==', color: '#6b4a33' },
  variants: [{ format: 'webp' as const, width: 240 }],
  focalPoint: null,
  credit: { rightsHolder: 'Reynal & Hitchcock', via: { name: 'Open Library', url: 'https://openlibrary.org/' } },
};
const statement = (property: string, dataType: string, content: unknown, qualifiers: unknown[] = []) => ({
  id: `01a1740d-7480-71e4-841f-${String(Math.abs(hash(property + JSON.stringify(content))))
    .padStart(12, '0')
    .slice(0, 12)}`,
  rank: 'normal',
  property: { id: property, data_type: dataType },
  value: value(content),
  qualifiers,
  references: [],
  rezics: { release: 'sha256:0', revision: 1 },
});
function hash(text: string) {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) % 1e12;
  return h;
}
const subjectBody = {
  subject: {
    id: subjectId,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:0',
    context,
    resolution: {},
    labels: { en: 'The Little Prince' },
    descriptions: {},
    aliases: {},
    statements: {
      'schema:abstract': [
        statement('schema:abstract', 'document', {
          language: 'en',
          document: fromMarkdown('A pilot meets a prince.', 'text'),
        }),
      ],
      'schema:character': [
        statement('schema:character', 'wikibase-item', characterId, [
          { property: { id: 'rezics:role', data_type: 'wikibase-item' }, value: value(roleId) },
        ]),
      ],
    },
  },
  related: {
    [characterId]: { labels: { en: 'The Fox' } },
    [roleId]: { labels: { en: 'Supporting' } },
    'schema:abstract': { labels: { en: 'Abstract' } },
  },
  summary: {
    id: subjectId,
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: 'The Little Prince', language: 'en' },
    creativeWork: true,
    cover,
  },
};

const holder = (n: number) => ({
  subject: `01a1740d-7480-71e4-841f-${String(n).padStart(12, '0')}`,
  property: 'wdt:P155',
  statement: `01a1740d-7480-71e4-841f-${String(n + 1000).padStart(12, '0')}`,
  label: `Holder ${n}`,
  type: 'schema:Book',
  summary: null,
});
const links = (count: number, exact = true, shown = Math.min(count, 12)) => ({
  status: 200,
  body: {
    links: Array.from({ length: shown }, (_, index) => holder(index + 1)),
    count: { value: count, exact },
    next: null,
  },
});
const collections = (count: number) => ({
  status: 200,
  body: {
    collections: Array.from({ length: Math.min(count, 6) }, (_, index) => ({
      id: `01a1740d-7480-71e4-841f-${String(index + 2000).padStart(12, '0')}`,
      curatorAccountId: 'account',
      curator: { id: 'account', handle: 'reader', displayName: null },
      title: `Shelf ${index + 1}`,
      multiplicity: 1,
    })),
    count: { value: count, exact: true },
    next: null,
  },
});

const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
const document = {
  root: { props: {} },
  content: [
    node('Cover', 'cover'),
    node('Summary', 'summary'),
    node('RelationGroups', 'relations', { property: 'wdt:P155', limit: 12 }),
    node('Appearances', 'characters', { property: 'schema:character', direction: 'forward', limit: 12 }),
    node('Credits', 'credits', { property: 'wdt:P725', limit: 12 }),
    node('RatingSummary', 'ratings'),
    node('ReviewList', 'reviews'),
    node('ThreadList', 'threads'),
    node('CollectionList', 'lists', { title: { en: 'Lists' }, limit: 6 }),
    node('Sources', 'sources'),
  ],
} satisfies CompositionDocument;

function pageOf(
  overrides: Partial<Record<'links' | 'credits' | 'collections' | 'subject', { status: number; body: unknown }>> = {},
): SubjectPageData {
  const plan = planReads(platformRegistry, document, { subject: subjectId });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') reads[key] = overrides.subject ?? { status: 200, body: subjectBody };
    else if (read.kind === 'collections') reads[key] = overrides.collections ?? collections(9);
    else if (read.kind === 'links' && read.property === 'wdt:P155') reads[key] = overrides.links ?? links(30, true, 30);
    else if (read.kind === 'links') reads[key] = overrides.credits ?? links(40, false);
  }
  return {
    subject: subjectId,
    profile: 'sha256:0',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: document as never,
    reads,
  };
}
const render = (page: SubjectPageData, locale = 'en') =>
  renderToString(
    createElement(
      RatingsContext.Provider,
      { value: { figures: [{ population: GLOBAL, count: 0 }], statistics: [], realms: [], own: null } },
      createElement(SubjectPage, { page, locale, messages, renderJsonLd: false } as never),
    ),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const section = (html: string, slot: string) =>
  new RegExp(`<section[^>]*data-slot="${slot}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';

test('Cover, Summary, RelationGroups, Appearances, Credits, CollectionList and Sources render from their page reads with a bounded preview, a count and a link to the full view', () => {
  const html = render(pageOf());
  expect(html).toContain('data-slot="subject-cover"');
  expect(text(section(html, 'subject-summary'))).toContain('A pilot meets a prince.');

  const relations = section(html, 'relation-groups');
  // Each card is drawn once for the phone row and once for the grid.
  expect(relations.match(/<article\b/g)).toHaveLength(24);
  expect(text(relations)).toContain('30 total');
  expect(relations).toContain(
    `href="/en/subjects/${subjectId}/${slug('The Little Prince')}/relations?property=wdt%3AP155"`,
  );

  const characters = section(html, 'appearances');
  expect(text(characters)).toContain('The Fox');
  expect(text(characters)).toContain('Supporting');
  expect(text(characters)).toContain('1 total');
  expect(characters).not.toContain('data-slot="see-all"');

  const credits = section(html, 'credits');
  expect(text(credits)).toContain('40+ total');
  expect(credits).toContain(`href="/en/subjects/${subjectId}/${slug('The Little Prince')}/credits"`);

  const lists = section(html, 'collection-list');
  expect(lists.match(/Shelf \d/g)).toHaveLength(6);
  expect(text(lists)).toContain('9 total');
  expect(lists).toContain(`href="/en/subjects/${subjectId}/${slug('The Little Prince')}/lists"`);

  const sources = section(html, 'subject-sources');
  expect(text(sources)).toContain('Reynal & Hitchcock');
  expect(sources).toContain(`href="/en/subjects/${subjectId}/${slug('The Little Prince')}/details"`);
  expect(html.match(/data-slot="subject-sources"/g)).toHaveLength(1);
});

test('RatingSummary keeps real reads while closed Reviews and Discussion sections render nothing', () => {
  const plan = planReads(platformRegistry, document, { subject: subjectId });
  expect(Object.values(plan.nodes)).toHaveLength(7);
  const html = render(pageOf());
  const ratings = section(html, 'rating-summary');
  expect(text(ratings)).toContain('No ratings yet');
  expect(ratings).toContain(`href="/en/subjects/${subjectId}/reviews"`);
  expect(section(html, 'review-list')).toBe('');
  expect(section(html, 'thread-list')).toBe('');
});
});

test('a data component never renders an id, a media id or a property CURIE', () => {
  const html = render(pageOf());
  const shown = text(html.replace(/<(?:a|link)\b[^>]*>/g, '<a>'));
  for (const raw of [
    subjectId,
    characterId,
    roleId,
    mediaId,
    'schema:character',
    'wdt:P155',
    'wdt:P725',
    'rezics:role',
  ]) {
    expect(shown).not.toContain(raw);
  }
  const unlabelled = pageOf({
    links: {
      status: 200,
      body: { links: [{ ...holder(1), label: undefined }], count: { value: 1, exact: true }, next: null },
    },
  });
  const bare = text(section(render(unlabelled), 'relation-groups'));
  expect(bare).toContain('Unlabelled');
  expect(bare).not.toContain('01a1740d');
});

test('a failed section read says so with a retry and the rest of the page renders', () => {
  const html = render(pageOf({ links: { status: 503, body: { code: 'unavailable' } } }));
  const failed = section(html, 'relation-groups');
  expect(failed).toContain('data-state="failed"');
  expect(text(failed)).toContain('could not be loaded');
  expect(failed).toContain('data-slot="retry"');
  expect(text(section(html, 'collection-list'))).toContain('Shelf 1');
  expect(text(section(html, 'subject-summary'))).toContain('A pilot meets a prince.');

  const subjectFailed = render(pageOf({ subject: { status: 500, body: {} } }));
  for (const slot of ['subject-cover', 'subject-summary', 'subject-sources'])
    expect(section(subjectFailed, slot)).toContain('data-state="failed"');
  expect(text(section(subjectFailed, 'relation-groups'))).toContain('30 total');
});
