import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { relationDefinitions } from '../src/subject/relations.ts';

const subjectId = '01a1740d-7480-71e4-841f-66c04022d7d0';
const context = '00000000-0000-8000-8000-000000000000';
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const row = (n: number) => `01a1740d-7480-71e4-841f-${String(n).padStart(12, '0')}`;

const release = {
  properties: {
    'wdt:P155': {
      labels: { en: 'follows', 'zh-Hans': '紧接着' },
      datatype: 'wikibase-item',
      relation: {
        group: 'order',
        order: 'date',
        inverse: 'wdt:P156',
        inverseLabels: { en: 'Sequel', 'zh-Hans': '续作' },
      },
    },
    'wdt:P144': {
      labels: { en: 'based on' },
      datatype: 'wikibase-item',
      relation: { group: 'derivation', order: 'name', inverse: 'wdt:P4969', inverseLabels: { en: 'Adaptations' } },
    },
    'rezics:sameSetting': {
      labels: { en: 'Same setting' },
      datatype: 'wikibase-item',
      relation: { group: 'world', order: 'name', symmetric: true },
    },
    'schema:exampleOfWork': {
      labels: { en: 'edition of' },
      datatype: 'wikibase-item',
      relation: {
        group: 'derivation',
        order: 'date',
        inverse: 'schema:workExample',
        inverseLabels: { en: 'Editions' },
      },
    },
    'rezics:newTerm': { labels: { en: 'Linked to' }, datatype: 'wikibase-item' },
  },
};
const properties = ['wdt:P155', 'wdt:P144', 'rezics:sameSetting', 'rezics:newTerm', 'rezics:missing'];

const cover = (n: number) => ({
  id: row(n),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: { value: `Holder ${n}`, language: 'en' },
  creativeWork: true,
  cover: {
    media: row(n + 500),
    width: 800,
    height: 1200,
    placeholder: { thumbhash: '3PcNNYSFeXh/b3eQa1p4iHaQeYD3/3gAAA==', color: '#6b4a33' },
    variants: [{ format: 'webp' as const, width: 240 }],
    focalPoint: null,
    credit: { rightsHolder: 'Someone', via: { name: 'Open Library', url: 'https://openlibrary.org/' } },
  },
});
const holder = (n: number, property: string, label = `Holder ${n}`, extra: Record<string, unknown> = {}) => ({
  subject: row(n),
  property,
  statement: row(n + 1000),
  label,
  type: 'schema:Book',
  summary: n % 2 ? cover(n) : null,
  ...extra,
});
const links = (items: unknown[], count = items.length, exact = true) => ({
  status: 200,
  body: { links: items, count: { value: count, exact }, next: null },
});

const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
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
    statements: {},
  },
  related: {},
  summary: null,
};

function pageOf(
  document: CompositionDocument,
  bodies: (read: ReturnType<typeof planReads>['reads'][string]) => { status: number; body: unknown },
): SubjectPageData {
  const plan = planReads(platformRegistry, document, { subject: subjectId });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) reads[key] = bodies(read);
  return {
    subject: subjectId,
    profile: 'sha256:0',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: document as never,
    reads,
  };
}
const render = (page: SubjectPageData, locale = 'en', props: Record<string, unknown> = {}) =>
  renderToString(createElement(SubjectPage, { page, locale, messages, renderJsonLd: false, ...props } as never));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const section = (html: string, slot: string) =>
  new RegExp(`<section[^>]*data-slot="${slot}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
// A group's heading, counts and cards. Each card is drawn once for the phone row and once for the grid.
const groupBlock = (html: string, group: string) =>
  new RegExp(
    `<div[^>]*data-slot="relation-group"[^>]*data-group="${group}"[\\s\\S]*?(?=<div[^>]*data-slot="relation-group"|</section>)`,
  ).exec(html)?.[0] ?? '';

const relationDocument = {
  root: { props: {} },
  content: [
    node('RelationGroups', 'sequels', { property: 'wdt:P155', limit: 12 }),
    node('RelationGroups', 'adaptations', { property: 'wdt:P144', limit: 12 }),
    node('RelationGroups', 'settings', { property: 'rezics:sameSetting', limit: 12 }),
  ],
} satisfies CompositionDocument;

const definitions = (locale: string) => relationDefinitions(release as never, properties, locale);

test("relations show from the reader's side with the property's inverse label, symmetric ones under the same label on both sides", () => {
  const en = definitions('en');
  expect(en['wdt:P155']).toEqual({ label: 'Sequel', group: 'order', symmetric: false });
  expect(en['wdt:P144']).toMatchObject({ label: 'Adaptations', group: 'derivation' });
  expect(definitions('zh-Hans')['wdt:P155']?.label).toBe('续作');
  // A symmetric fact reads the same from both sides, so its one label serves the inverse read too.
  expect(en['rezics:sameSetting']).toEqual({ label: 'Same setting', group: 'world', symmetric: true });
  // A property with no relation definition yet falls back to its label and the other group.
  expect(en['rezics:newTerm']).toEqual({ label: 'Linked to', group: 'other', symmetric: false });
  expect(en['rezics:missing']).toBeUndefined();

  const page = pageOf(relationDocument, (read) =>
    read.kind === 'links'
      ? links([holder(1, read.property), holder(2, read.property)])
      : { status: 200, body: subjectBody },
  );
  const html = render(page, 'en', { relations: en });
  const shown = text(section(html, 'relation-groups'));
  expect(shown).toContain('Sequel');
  expect(shown).toContain('Adaptations');
  // Two holders, each drawn for the phone row and for the grid.
  expect(shown.match(/Same setting/g)).toHaveLength(4);
  expect(shown).not.toMatch(/follows|based on/);
  expect(text(render(page, 'zh-Hans', { relations: definitions('zh-Hans') }))).toContain('续作');

  // The other side of the symmetric fact reads the same inverse read, so it shows the same label.
  const other = pageOf(relationDocument, (read) =>
    read.kind === 'links' && read.property === 'rezics:sameSetting'
      ? links([holder(9, read.property)])
      : read.kind === 'links'
        ? links([])
        : { status: 200, body: subjectBody },
  );
  expect(text(section(render(other, 'en', { relations: en }), 'relation-groups'))).toContain('Same setting');

  // Without any definition a relation still renders, under its holder's name alone.
  const bare = text(section(render(page), 'relation-groups'));
  expect(bare).toContain('Holder 1');
  expect(bare).not.toMatch(/wdt:|rezics:/);
});

test('relations are grouped by relation group, each group with its count, cover, title, label and date, and series order shown as order', () => {
  const page = pageOf(relationDocument, (read) => {
    if (read.kind !== 'links') return { status: 200, body: subjectBody };
    if (read.property === 'wdt:P155')
      return links([
        holder(1, read.property, 'Second Voyage', { date: '2012-05' }),
        holder(2, read.property, 'Third Voyage', { date: '2015' }),
      ]);
    if (read.property === 'wdt:P144')
      return links(
        Array.from({ length: 12 }, (_, i) => holder(10 + i, read.property, `Adaptation ${i + 1}`)),
        30,
        false,
      );
    return links([holder(40, read.property, 'Another Planet')]);
  });
  const html = render(page, 'en', { relations: definitions('en') });
  const groups = [...html.matchAll(/data-slot="relation-group"[^>]*data-group="([a-z]+)"/g)].map((match) => match[1]);
  expect(groups).toEqual(['order', 'derivation', 'world']);

  const order = groupBlock(html, 'order');
  expect(text(order)).toContain('2 total');
  expect(text(order)).toContain('Second Voyage');
  expect(text(order)).toContain('Sequel');
  expect(text(order)).toContain('Sequel · 2012');
  expect(text(order)).toContain('2015');
  expect(order).toContain('/media/');
  expect(order.indexOf('Second Voyage')).toBeLessThan(order.indexOf('Third Voyage'));

  const derivation = groupBlock(html, 'derivation');
  expect(derivation.match(/<article\b/g)).toHaveLength(24);
  expect(text(derivation)).toContain('30+ total');
  expect(derivation).toContain(`href="/en/subjects/${subjectId}/relations?property=wdt%3AP144"`);
  expect(groupBlock(html, 'order')).not.toContain('/relations?property=');

  expect(text(groupBlock(html, 'world'))).toContain('1 total');
});

test('SubjectList and TypeList show an exact or at-least count and a See all link to a paged view', () => {
  const document = {
    root: { props: {} },
    content: [
      node('SubjectList', 'editions', { title: { en: 'Editions' }, property: 'schema:exampleOfWork', limit: 12 }),
      node('SubjectList', 'works', { title: { en: 'Works' }, property: 'schema:author', limit: 12 }),
      node('SubjectList', 'parts', { title: { en: 'Parts' }, property: 'schema:isPartOf', limit: 12 }),
      node('TypeList', 'books', { title: { en: 'Books' }, types: ['schema:Book'], sort: 'name', limit: 12 }),
    ],
  } satisfies CompositionDocument;
  const page = pageOf(document, (read) => {
    if (read.kind === 'links' && read.property === 'schema:exampleOfWork')
      return links(
        Array.from({ length: 12 }, (_, i) => holder(i + 1, read.property)),
        30,
      );
    if (read.kind === 'links' && read.property === 'schema:author')
      return links(
        Array.from({ length: 12 }, (_, i) => holder(i + 1, read.property)),
        40,
        false,
      );
    if (read.kind === 'links') return links([holder(70, read.property), holder(71, read.property)]);
    if (read.kind === 'search')
      return {
        status: 200,
        body: {
          subjects: [{ id: row(80), type: 'schema:Book', labels: { en: 'A Book' }, summary: cover(81) }],
          total: { value: 120, relation: 'lower_bound' },
        },
      };
    return { status: 200, body: subjectBody };
  });
  const html = render(page);

  const lists = [...html.matchAll(/<section[^>]*data-slot="subject-list"[\s\S]*?<\/section>/g)].map(
    (match) => match[0],
  );
  expect(lists).toHaveLength(3);
  expect(text(lists[0]!)).toContain('30 total');
  expect(lists[0]).toContain(`href="/en/subjects/${subjectId}/relations?property=schema%3AexampleOfWork"`);
  expect(text(lists[1]!)).toContain('40+ total');
  expect(lists[1]).toContain(`href="/en/subjects/${subjectId}/relations?property=schema%3Aauthor"`);
  // A list that fits shows its count and no link to a view that would repeat it.
  expect(text(lists[2]!)).toContain('2 total');
  expect(lists[2]).not.toContain('data-slot="see-all"');

  const types = section(html, 'type-list');
  expect(text(types)).toContain('120+ total');
  expect(types).toContain('href="/en/search?type=schema%3ABook"');
});

test('inverse lists are ordered by their declared key (series position, credit order, date) before name', () => {
  const document = {
    root: { props: {} },
    content: [
      node('SubjectList', 'parts', { title: { en: 'Parts' }, property: 'wdt:P179', limit: 12 }),
      node('RelationGroups', 'sequels', { property: 'wdt:P155', limit: 12 }),
    ],
  } satisfies CompositionDocument;
  // The inverse read orders by the property's declared key; a name-sorted search could not.
  const plan = planReads(platformRegistry, document, { subject: subjectId });
  expect(Object.values(plan.reads)).toEqual([
    { kind: 'links', id: subjectId, property: 'wdt:P179', limit: 12 },
    { kind: 'links', id: subjectId, property: 'wdt:P155', limit: 12 },
  ]);

  // Alphabetical order would put Aardvark first; the declared position and date put it last.
  const page = pageOf(document, (read) =>
    read.kind === 'links' && read.property === 'wdt:P179'
      ? links([
          holder(1, read.property, 'Zebra Volume'),
          holder(2, read.property, 'Mango Volume'),
          holder(3, read.property, 'Aardvark Volume'),
        ])
      : read.kind === 'links'
        ? links([
            holder(4, read.property, 'Zulu Sequel', { date: '2010' }),
            holder(5, read.property, 'Alpha Sequel', { date: '2014' }),
          ])
        : { status: 200, body: subjectBody },
  );
  const html = render(page, 'en', { relations: definitions('en') });
  const parts = text(section(html, 'subject-list'));
  expect(parts.indexOf('Zebra Volume')).toBeLessThan(parts.indexOf('Mango Volume'));
  expect(parts.indexOf('Mango Volume')).toBeLessThan(parts.indexOf('Aardvark Volume'));
  const sequels = text(groupBlock(html, 'order'));
  expect(sequels.indexOf('Zulu Sequel')).toBeLessThan(sequels.indexOf('Alpha Sequel'));
});
