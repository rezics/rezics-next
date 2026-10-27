import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { agentAccount, demoAgentSubjects } from '../src/kernel/agent-fixtures.ts';
import { createFakeKernelFetch, type FixtureAccount } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { agentPath, loadAgentPage } from '../src/features/pages/agent.tsx';
import { RelationsView } from '../src/features/pages/relations-view.tsx';
import { PlainLink } from '../src/features/pages/shared.tsx';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import { subjectTabs } from '../src/features/pages/views.ts';
import { SPOILER_PROPERTY } from '../src/features/pages/values.tsx';
import { relationDefinitions } from '../src/subject/relations.ts';
import { defaultReader } from '../src/subject/reader.ts';

const subjectId = '01a1740d-7480-71e4-841f-66c04022d7d0';
const characterId = '01a1740d-7480-71e4-841f-66c04022d7c0';
const hiddenId = '01a1740d-7480-71e4-841f-66c04022d7c1';
const context = '00000000-0000-8000-8000-000000000000';
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const row = (n: number) => `01a1740d-7480-71e4-841f-${String(n).padStart(12, '0')}`;

const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};

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
const holder = (n: number, property: string, extra: Record<string, unknown> = {}) => ({
  subject: row(n),
  property,
  statement: row(n + 1000),
  label: `Holder ${n}`,
  type: 'schema:Book',
  summary: cover(n),
  ...extra,
});
const links = (items: unknown[], count = items.length, exact = true) => ({
  status: 200,
  body: { links: items, count: { value: count, exact }, next: null },
});
const statement = (property: string, content: string, qualifiers: unknown[] = []) => ({
  id: row(Math.abs([...(property + content)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1e9, 7))),
  rank: 'normal',
  property: { id: property, data_type: 'wikibase-item' },
  value: { type: 'value', content },
  qualifiers,
  references: [],
  rezics: { release: 'sha256:0', revision: 1 },
});
const role = (text: string) => ({
  property: { id: 'rezics:roleName', data_type: 'string' },
  value: { type: 'value', content: text },
});
const spoiler = {
  property: { id: SPOILER_PROPERTY, data_type: 'quantity' },
  value: { type: 'value', content: { amount: '2' } },
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
    statements: {
      'schema:character': [
        statement('schema:character', characterId, [role('Supporting')]),
        statement('schema:character', hiddenId, [spoiler]),
      ],
    },
  },
  related: { [characterId]: { labels: { en: 'The Fox' } }, [hiddenId]: { labels: { en: 'The Snake' } } },
  summary: null,
};

const release = {
  properties: {
    'wdt:P155': {
      labels: { en: 'follows' },
      datatype: 'wikibase-item',
      relation: { group: 'order', order: 'date', inverse: 'wdt:P156', inverseLabels: { en: 'Sequel' } },
    },
    'wdt:P144': {
      labels: { en: 'based on' },
      datatype: 'wikibase-item',
      relation: { group: 'derivation', order: 'name', inverse: 'wdt:P4969', inverseLabels: { en: 'Adaptations' } },
    },
  },
};
const relations = relationDefinitions(release as never, ['wdt:P155', 'wdt:P144'], 'en');

const document = {
  root: { props: {} },
  content: [
    node('SubjectList', 'editions', { title: { en: 'Editions' }, property: 'schema:exampleOfWork', limit: 12 }),
    node('SubjectList', 'parts', { title: { en: 'Parts' }, property: 'schema:isPartOf', limit: 12 }),
    node('RelationGroups', 'sequels', { property: 'wdt:P155', limit: 12 }),
    node('RelationGroups', 'adaptations', { property: 'wdt:P144', limit: 12 }),
    node('Appearances', 'characters', { property: 'schema:character', direction: 'forward', limit: 12 }),
    node('Credits', 'credits', { property: 'wdt:P725', limit: 12 }),
  ],
} satisfies CompositionDocument;

function subjectPage(): SubjectPageData {
  const plan = planReads(platformRegistry, document, { subject: subjectId });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind !== 'links') reads[key] = { status: 200, body: subjectBody };
    else if (read.property === 'schema:exampleOfWork')
      reads[key] = links([1, 2, 3].map((n) => holder(n, read.property, { date: `${2010 + n}-05-17` })));
    else if (read.property === 'schema:isPartOf')
      reads[key] = links(
        [4, 5].map((n) => holder(n, read.property)),
        30,
      );
    else if (read.property === 'wdt:P155')
      reads[key] = links([6, 7].map((n) => holder(n, read.property, { date: '2012-05' })));
    else if (read.property === 'wdt:P144') reads[key] = links([8].map((n) => holder(n, read.property)));
    else reads[key] = links([9, 10, 11].map((n) => holder(n, read.property)));
  }
  return {
    subject: subjectId,
    profile: 'sha256:0',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: document as never,
    reads,
  };
}
const renderSubject = (page: SubjectPageData, props: Record<string, unknown> = {}) =>
  renderToString(
    createElement(SubjectPage, { page, locale: 'en', messages, renderJsonLd: false, relations, ...props } as never),
  );
const section = (html: string, slot: string) =>
  new RegExp(`<section[^>]*data-slot="${slot}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The phone rows and the grids of one section: each row comes first and is hidden from sm up. */
function layouts(html: string) {
  const found = { row: '', grid: '' };
  const starts = [...html.matchAll(/data-slot="cover-(row|grid)"/g)];
  for (const [index, match] of starts.entries()) {
    if (match.index === undefined) continue;
    const start = html.lastIndexOf('<', match.index);
    const end = starts[index + 1]?.index ?? html.length;
    found[match[1] as 'row' | 'grid'] += html.slice(start, end);
  }
  return found;
}
const cards = (html: string) =>
  html
    .split('<article')
    .slice(1)
    .map((card) => `<article${card.split('</article>')[0]!}</article>`);
const titleOf = (card: string) => text(/<a\b[^>]*>([\s\S]*?)<\/a>/.exec(card)?.[1] ?? '');
const secondaryOf = (card: string) =>
  text(/<div\b[^>]*data-slot="cover-card-secondary"[^>]*>([\s\S]*?)<\/div>/.exec(card)?.[1] ?? '');
const hrefsOf = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]!);

const previewSlots = ['subject-list', 'relation-groups', 'appearances', 'credits'] as const;

test('subject previews render as cover cards: the cover first and edge to edge, the title and one secondary line', () => {
  const html = renderSubject(subjectPage());
  for (const slot of previewSlots) {
    const body = section(html, slot);
    expect(body).toContain('data-slot="cover-grid"');
    for (const card of cards(layouts(body).grid)) {
      // The cover is the card's top, drawn by the shared Cover without a frame of its own, then the title link.
      expect(card).toMatch(/^[^>]*>\s*<[^>]*data-slot="(?:cover|aspect-ratio)"/);
      expect(card).toMatch(/<a\b[^>]*href="\/en\/subjects\//);
    }
    // The list rows of the previous layout are gone.
    expect(body).not.toMatch(/<(?:ul|ol|li)\b/);
  }

  // The secondary line is the relation label with the year, the role, or the edition year; never more than one line.
  const relationGroups = section(html, 'relation-groups');
  const sequel = cards(layouts(relationGroups).grid).find((card) => titleOf(card) === 'Holder 6')!;
  expect(secondaryOf(sequel)).toBe('Sequel · 2012');
  const editions = cards(layouts(section(html, 'subject-list')).grid);
  expect(editions).toHaveLength(3);
  expect(editions.filter((card) => card.includes('<img') && card.includes('src="/media/'))).toHaveLength(3);
  expect(titleOf(editions[0]!)).toBe('Holder 1');
  expect(secondaryOf(editions[0]!)).toBe('2011');
  const fox = cards(layouts(section(html, 'appearances')).grid)[0]!;
  expect(titleOf(fox)).toBe('The Fox');
  expect(secondaryOf(fox)).toBe('Supporting');
  for (const slot of previewSlots)
    for (const card of cards(layouts(section(html, slot)).grid))
      expect((card.match(/line-clamp-1/g) ?? []).length).toBeLessThanOrEqual(1);

  // Headings, counts and See all links stay as they were.
  const [, parts] = [...html.matchAll(/<section[^>]*data-slot="subject-list"[\s\S]*?<\/section>/g)].map((m) => m[0]);
  expect(text(parts!)).toContain('30 total');
  expect(parts).toContain(`href="/en/subjects/${subjectId}/relations?property=schema%3AisPartOf"`);
  expect(cards(layouts(parts!).grid)).toHaveLength(2);
  expect(text(relationGroups)).toContain('Sequel');
  expect(text(relationGroups)).toContain('Adaptations');
});

test('one ratio is shared by the covers of a list', () => {
  const html = renderSubject(subjectPage());
  for (const slot of previewSlots) {
    const grid = layouts(section(html, slot)).grid;
    const ratios = new Set([...grid.matchAll(/data-slot="cover"[^>]*data-ratio="([\d:]+)"/g)].map((match) => match[1]));
    expect(ratios.size).toBe(1);
  }
});

test('below sm a preview is one snapping row of at least two and a half cards at 390 wide; from sm up it is a grid', () => {
  const html = renderSubject(subjectPage());
  for (const slot of previewSlots) {
    const body = section(html, slot);
    const { row, grid } = layouts(body);
    // The row is shown on a phone only and the grid from sm up.
    expect(body).toMatch(
      /class="[^"]*\bsm:hidden\b[^"]*"[^>]*data-layout="cover-row"|data-layout="cover-row"[^>]*class="[^"]*\bsm:hidden\b/,
    );
    expect(body).toMatch(
      /class="[^"]*\bhidden sm:block\b[^"]*"[^>]*data-layout="cover-grid"|data-layout="cover-grid"[^>]*class="[^"]*\bhidden sm:block\b/,
    );
    expect(row).toMatch(/role="region"/);
    expect(row).toMatch(/\boverflow-x-auto\b/);
    expect(row).toMatch(/\bsnap-x\b/);
    expect(row).toMatch(/\[&amp;(?:&gt;|>)\*\]:snap-start/);
    expect(cards(row).length).toBe(cards(grid).length);

    // The visible part of the row at 390 wide, inside the page's 16 px side padding.
    const width = Number(/\[&amp;(?:&gt;|>)\*\]:w-\[([\d.]+)rem\]/.exec(row)?.[1]) * 16;
    const gap = Number(/\bgap-(\d+)\b/.exec(row)?.[1]) * 4;
    expect(width).toBeGreaterThan(0);
    const visible = (390 - 32 + gap) / (width + gap);
    expect(visible).toBeGreaterThanOrEqual(2.5);
    // More cards than fit, so the row scrolls.
    if (cards(row).length >= 5) expect(cards(row).length * (width + gap)).toBeGreaterThan(390);

    // The grid is the shared one: two columns on a phone-width container, auto-fill from a wider one.
    expect(grid).toMatch(/repeat\(auto-fill,minmax\(8\.75rem,1fr\)\)/);
  }
});

test('every card is one link named by the subject title, and the row is reachable and scrollable by keyboard', () => {
  const html = renderSubject(subjectPage());
  for (const slot of previewSlots) {
    const body = section(html, slot);
    const { row, grid } = layouts(body);
    for (const part of [row, grid]) {
      for (const card of cards(part)) {
        const anchors = [...card.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)];
        expect(anchors).toHaveLength(1);
        expect(text(anchors[0]![1]!).length).toBeGreaterThan(0);
        // The cover repeats the title, so it is decorative and adds no second name.
        expect(card).not.toMatch(/<img[^>]*\balt="[^"]+"/);
      }
    }
    expect(row).toMatch(/role="region"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*role="region"/);
    expect(row).toMatch(/tabindex="0"/);
  }
  const editions = layouts(section(html, 'subject-list')).row;
  expect(hrefsOf(editions)).toEqual([1, 2, 3].map((n) => `/en/subjects/${row(n)}`));
});

test('a spoiler-hidden item keeps its reveal control on the card', () => {
  const html = renderSubject(subjectPage());
  const characters = section(html, 'appearances');
  expect(characters).toContain('The Fox');
  expect(characters).not.toContain('The Snake');
  for (const part of Object.values(layouts(characters)))
    expect(part.match(/<button\b[^>]*data-slot="collapsible-trigger"[^>]*>Show spoiler<\/button>/g)).toHaveLength(1);
});

test('the full relations view uses the responsive cover grid and keeps its continuation link', () => {
  const body = {
    links: [
      ...[1, 2, 3, 4].map((n) => holder(n, 'wdt:P155', { date: '2015' })),
      ...[5, 6, 7].map((n) => holder(n, 'wdt:P144')),
    ],
    count: { value: 250, exact: true },
    next: 'opaque-cursor',
  };
  const html = renderToString(
    createElement(RelationsView, {
      locale: 'en',
      subject: subjectId,
      frame: null,
      data: { body, property: null },
      relations,
      value: {
        locale: 'en',
        link: PlainLink,
        reader: defaultReader,
        labels: {
          spoilerShow: 'Show',
          documentSpoiler: 'Reveal',
          cover: { withheld: 'w', reveal: 'r', credit: 'c', via: 'v' },
        },
        unlabelled: 'Unlabelled',
        spoilerShow: 'Show',
      },
    } as never),
  );
  expect(html).not.toContain('data-slot="cover-row"');
  expect(html.match(/data-slot="cover-grid"/g)).toHaveLength(2);
  expect(html.match(/<article/g)).toHaveLength(7);
  expect(html).not.toMatch(/<(?:ul|ol|li)\b/);
  const grid = html.slice(html.indexOf('data-slot="cover-grid"'));
  expect(grid).toMatch(/repeat\(auto-fill,minmax\(8\.75rem,1fr\)\)/);
  expect(grid).toContain('gap-2');
  for (const card of cards(html)) expect([...card.matchAll(/<a\b/g)]).toHaveLength(1);
  expect(titleOf(cards(html)[0]!)).toBe('Holder 1');
  expect(secondaryOf(cards(html)[0]!)).toBe('Sequel · 2015');
  expect(html).toContain(`data-slot="next-page"`);
  expect(html).toContain(`href="/en/subjects/${subjectId}/relations?cursor=opaque-cursor"`);
  expect(text(html)).toContain('250 total');
});

test('agent pages show works and characters as cover cards', async () => {
  const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${n.toString(16).padStart(12, '0')}`;
  const novelist = demoAgentSubjects[0]!.id;
  const item = (n: number, type: string, label: string, statements: Record<string, unknown[]> = {}) => ({
    id: id(n),
    type,
    labels: { en: label },
    descriptions: {},
    aliases: {},
    statements,
  });
  const authored = (property: string) => [
    {
      id: id(0x5000),
      rank: 'normal',
      property: { id: property, data_type: 'wikibase-item' },
      value: { type: 'value', content: novelist },
      qualifiers: [],
      references: [],
    },
  ];
  const subjects = [
    ...fixtures.subjects,
    ...demoAgentSubjects,
    item(0x6001, 'schema:Book', 'River Atlas', { 'schema:author': authored('schema:author') }),
    item(0x6002, 'schema:Book', 'Salt Roads', { 'schema:author': authored('schema:author') }),
    item(0x6003, 'wd:Q95074', 'Captain Ume', { 'wdt:P725': authored('wdt:P725') }),
  ];
  const accounts: FixtureAccount[] = [
    agentAccount({ id: id(0x7003), handle: 'haruka', displayName: 'Haruka Aizawa', subject: novelist }, { posts: 1 }),
  ];
  const local = createFakeKernelFetch({ ...fixtures, subjects, accounts } as never);
  const client = createKernelClient('https://kernel.invalid', { fetch: local as never });
  const result = await loadAgentPage(client, 'haruka');
  if (result.kind !== 'page') throw new Error('expected the agent page');
  const names = Object.fromEntries(
    [
      'overview',
      'editions',
      'contents',
      'characters',
      'appearances',
      'credits',
      'works',
      'relations',
      'posts',
      'reviews',
      'discussion',
      'lists',
      'collections',
      'details',
    ].map((view) => [view, view]),
  );
  const html = renderToString(
    createElement(SubjectPage, {
      page: result.page,
      locale: 'en',
      messages,
      tabs: subjectTabs(result.page),
      tabLabels: { views: 'Agent views', names },
      base: agentPath('en', 'haruka'),
      view: 'overview',
      renderJsonLd: false,
    } as never),
  );
  const rows = html.match(/data-slot="cover-row"/g) ?? [];
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(html.match(/data-slot="cover-grid"/g)).toHaveLength(rows.length);
  for (const title of ['River Atlas', 'Salt Roads', 'Captain Ume']) {
    expect(html).toContain(title);
    const link = new RegExp(`<a\\b[^>]*href="/en/subjects/[^"]+"[^>]*>${title}</a>`, 'g');
    expect(html.match(link)).toHaveLength(2);
  }
  // The works are no longer a vertical list with the cover beside the title.
  expect(html).not.toMatch(/<li\b[^>]*>\s*<div class="flex min-w-0 items-center gap-3">/);
});
