import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry } from '@rezics/composition';
import { fieldLabel } from '../src/features/pages/shared.tsx';
import { SubjectPage } from '../src/features/pages/subject.tsx';
import { RelationsView } from '../src/features/pages/relations-view.tsx';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { localizedLabel } from '../src/search/results.tsx';

const id = '01a1740d-7480-71e4-841f-66c04022d7d0';
const authorId = '01a1740d-7480-71e4-841f-66c04022d7d1';
const val = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, datatype: string, content: unknown) => ({
  id: `statement-${property}`,
  rank: 'normal',
  property: { id: property, data_type: datatype },
  value: val(content),
  qualifiers: [],
  references: [],
});
const document = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'hero' } },
    { type: 'MoreStatements', props: { id: 'facts' } },
  ],
};
const subject = {
  id,
  type: 'schema:Book',
  revision: 1,
  release: 'sha256:0',
  context: '00000000-0000-8000-8000-000000000000',
  resolution: {},
  labels: { en: 'A book' },
  descriptions: {},
  aliases: {},
  statements: {
    'schema:author': [statement('schema:author', 'wikibase-item', authorId)],
    'schema:datePublished': [
      statement('schema:datePublished', 'time', {
        time: '+1943-04-06T00:00:00Z',
        precision: 11,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      }),
    ],
    'schema:isbn': [statement('schema:isbn', 'external-id', 'ISBN-13')],
    'schema:keywords': [statement('schema:keywords', 'string', 'lowercase tag')],
  },
};
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
const page = (() => {
  const reads: Record<string, { status: number; body: unknown }> = {};
  for (const [key, planned] of Object.entries(planReads(platformRegistry, document as never, { subject: id }).reads)) {
    reads[key] =
      planned.kind === 'subject'
        ? {
            status: 200,
            body: {
              subject,
              related: {
                [authorId]: { labels: { en: 'bell hooks' } },
                'schema:author': { labels: { en: 'author' } },
                'schema:datePublished': { labels: { en: 'publication date' } },
                'schema:isbn': { labels: { en: 'ISBN-13' } },
                'schema:keywords': { labels: { en: 'keywords' } },
              },
              summary: null,
            },
          }
        : planned.kind === 'links'
          ? { status: 200, body: { links: [], count: { value: 0, exact: true }, next: null } }
          : planned.kind === 'collections'
            ? { status: 200, body: { collections: [], count: { value: 0, exact: true }, next: null } }
            : { status: 200, body: { subjects: [], total: { value: 0, relation: 'exact' }, next: null, as_of: '' } };
  }
  return { subject: id, profile: 'sha256:0', template: { scope: 'base', key: 'schema:Book' }, document, reads };
})();

const renderedPage = renderToString(
  createElement(SubjectPage, { page: page as never, locale: 'en', messages, renderJsonLd: false } as never),
);

test('property field labels capitalize their first character in the label language', () => {
  expect(fieldLabel(localizedLabel({ en: 'author' }, 'en'), 'en').text).toBe('Author');
  expect(fieldLabel(localizedLabel({ en: 'publication date' }, 'en'), 'en').text).toBe('Publication date');
  expect(fieldLabel(localizedLabel({ en: 'publication date' }, 'de'), 'de').text).toBe('Publication date');
  expect(fieldLabel({ text: 'istanbul', lang: 'tr' }, 'de').text).toBe('İstanbul');
});

test('labels without lowercase case stay exactly as defined', () => {
  expect(fieldLabel(localizedLabel({ zh: '出版日期' }, 'zh'), 'zh').text).toBe('出版日期');
  expect(fieldLabel(localizedLabel({ en: 'ISBN-13' }, 'en'), 'en').text).toBe('ISBN-13');
});

test('facet group labels are formatted as field names after localization', () => {
  const field = fieldLabel(localizedLabel({ en: 'author' }, 'en'), 'en');
  expect(field.text).toBe('Author');
  expect(field.lang).toBe('en');
});

test('relation property headings capitalize the definition label', () => {
  const html = renderToString(
    createElement(RelationsView, {
      locale: 'en',
      subject: { id, label: 'A book' },
      frame: null,
      data: { body: { links: [], count: { value: 0, exact: true }, next: null }, property: 'schema:author' },
      relations: { 'schema:author': { label: 'author', group: 'association', symmetric: false } },
      value: {} as never,
    }),
  );
  expect(html).toContain(
    '<h1 class="font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Author</h1>',
  );
});

test('subject field labels are capitalized while the hero and fact values retain their definitions', () => {
  expect(renderedPage).toContain('<dt lang="en" class="font-semibold">Author</dt>');
  expect(renderedPage).toContain('<dt lang="en" class="font-semibold">Publication date</dt>');
  expect(renderedPage).toContain('<dt lang="en" class="font-semibold">ISBN-13</dt>');
  expect(renderedPage).toContain('>bell hooks</a>');
  expect(renderedPage).toContain('lowercase tag');
});
