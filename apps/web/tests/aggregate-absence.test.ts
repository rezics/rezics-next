import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { RelationsView } from '../src/features/pages/relations-view.tsx';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import { PlainLink } from '../src/features/pages/shared.tsx';
import type { RelationDefinition } from '../src/subject/relations.ts';
import { defaultReader } from '../src/subject/reader.ts';
import { subjectTabs } from '../src/features/pages/views.ts';
import type { ViewTabLabels } from '../src/features/pages/view-tabs.tsx';

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80';
const properties = ['rezics:countedOrder', 'rezics:uncountedOrder', 'rezics:worldRelation'] as const;
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled subject',
  sources: 'Sources',
  aliases: 'Also known as',
  details: 'Details',
};
const names: Record<View, string> = {
  overview: 'Overview',
  editions: 'Editions',
  contents: 'Contents',
  characters: 'Characters',
  appearances: 'Appearances',
  credits: 'Credits',
  works: 'Works',
  relations: 'Relations',
  posts: 'Posts',
  reviews: 'Reviews',
  discussion: 'Discussion',
  lists: 'Lists',
  collections: 'Collections',
  details: 'Details',
};
const tabLabels: ViewTabLabels = { views: 'Subject views', names };
const labels = {
  spoilerShow: 'Show',
  documentSpoiler: 'Reveal',
  cover: { withheld: 'Withheld', reveal: 'Reveal', credit: 'Credit', via: 'Via' },
};

type LinkBody = { links: Record<string, unknown>[]; count?: { value: number; exact: boolean }; next?: string | null };

function subjectList(id = 'works', property = 'schema:author', limit = 2) {
  return { type: 'SubjectList', props: { id, property, limit, title: { en: 'Works' } } };
}

function relationNode(id: string, property: string) {
  return { type: 'RelationGroups', props: { id, property, limit: 2 } };
}

function page(
  nodes: Record<string, unknown>[],
  bodies: Record<string, LinkBody>,
  views: string[] = ['overview', 'works', 'relations', 'discussion', 'details'],
): SubjectPageData {
  const document = { root: { props: {} }, content: nodes } as unknown as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'links')
      reads[key] = { status: 200, body: bodies[read.property] ?? { links: [], count: { value: 0, exact: true } } };
  }
  return {
    subject,
    profile: 'sha256:test',
    template: { scope: 'type', key: 'schema:Book' },
    document,
    views,
    reads,
  } satisfies SubjectPageData;
}

const definitions: Record<string, RelationDefinition> = {
  [properties[0]]: { label: 'Counted order relation', group: 'order', symmetric: false },
  [properties[1]]: { label: 'Uncounted order relation', group: 'order', symmetric: false },
  [properties[2]]: { label: 'World relation', group: 'world', symmetric: false },
};

function renderPage(data: SubjectPageData, view: View = 'overview') {
  return renderToString(
    createElement(SubjectPage, {
      page: data,
      locale: 'en',
      messages,
      view,
      tabs: subjectTabs(data),
      tabLabels,
      relations: definitions,
      ...(view === 'overview'
        ? {}
        : { heading: { title: 'The subject', label: names[view], href: `/en/subjects/${subject}` } }),
      renderJsonLd: false,
    } as never),
  );
}

function section(html: string, slot: string) {
  return new RegExp(`<section\\b[^>]*data-slot="${slot}"[\\s\\S]*?<\\/section>`).exec(html)?.[0] ?? '';
}

function groupBlock(html: string, group: string) {
  return (
    new RegExp(
      `<div[^>]*data-slot="relation-group"[^>]*data-group="${group}"[\\s\\S]*?(?=<div[^>]*data-slot="relation-group"|<p role="status"|<\\/section>)`,
    ).exec(section(html, 'relation-groups'))?.[0] ?? ''
  );
}

function countTextValues(html: string) {
  return [...html.matchAll(/<span data-slot="count"[^>]*>([\s\S]*?)<\/span>/g)].map((match) =>
    match[1]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&'),
  );
}

function links(count?: LinkBody['count'], next: LinkBody['next'] = null, returned = 1): LinkBody {
  return {
    links: Array.from({ length: returned }, (_, index) => ({
      subject: `0192f3a0-6c1e-7b2a-9d4e-${(0x100 + index).toString(16).padStart(12, '0')}`,
      property: 'schema:author',
      label: `Work ${index + 1}`,
    })),
    ...(count ? { count } : {}),
    next,
  };
}

test('a links preview without a count shows returned items and offers See all exactly for continuation or overflow', () => {
  const cases = [
    { body: links(undefined, null, 1), limit: 2, more: false },
    { body: links(undefined, 'opaque-cursor', 1), limit: 2, more: true },
    { body: links(undefined, null, 2), limit: 1, more: true },
    { body: links(undefined, null, 2), limit: 2, more: false },
  ];
  for (const [index, current] of cases.entries()) {
    const data = page([subjectList('works', 'schema:author', current.limit)], { 'schema:author': current.body });
    const html = renderPage(data);
    const preview = section(html, 'subject-list');
    expect(preview, `case ${index + 1}`).toContain(`Work 1`);
    expect(countTextValues(preview), `case ${index + 1}`).toEqual([]);
    expect(preview.includes('data-slot="see-all"'), `case ${index + 1}`).toBe(current.more);
    if (current.limit === 1) expect(preview).not.toContain('Work 2');
  }
});

test('a view fed by a count-free links preview is offered without a count and is not folded into Overview', () => {
  const data = page([subjectList()], { 'schema:author': links(undefined, null, 1) });
  const tabs = subjectTabs(data);
  const works = tabs.find(({ view }) => view === 'works');
  expect(works).toEqual({ view: 'works' });
  expect(tabs.map(({ view }) => view)).toContain('works');

  const html = renderPage(data);
  const viewTabs = /<nav[^>]*data-slot="view-tabs"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  const worksTab = /<a[^>]*data-view="works"[\s\S]*?<\/a>/.exec(viewTabs)?.[0] ?? '';
  expect(worksTab).toContain('Works');
  expect(countTextValues(worksTab)).toEqual([]);
});

test('relation group totals are omitted for an uncounted member and retain exact or plus totals when all members are counted', () => {
  const nodes = [
    relationNode('counted-order', properties[0]),
    relationNode('uncounted-order', properties[1]),
    relationNode('world', properties[2]),
  ];
  const allCounted = page(nodes, {
    [properties[0]]: {
      links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000101', property: properties[0], label: 'Order one' }],
      count: { value: 2, exact: true },
    },
    [properties[1]]: {
      links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000102', property: properties[1], label: 'Order two' }],
      count: { value: 3, exact: false },
    },
    [properties[2]]: {
      links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000103', property: properties[2], label: 'World one' }],
      count: { value: 4, exact: true },
    },
  });
  const countedHtml = renderPage(allCounted);
  const relationSection = section(countedHtml, 'relation-groups');
  expect(countTextValues(relationSection)).toEqual(['9+', '5+', '4']);

  const oneUncounted = page(nodes, {
    [properties[0]]: {
      links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000101', property: properties[0], label: 'Order one' }],
      count: { value: 2, exact: true },
    },
    [properties[1]]: {
      links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000102', property: properties[1], label: 'Order two' }],
    },
    [properties[2]]: {
      links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000103', property: properties[2], label: 'World one' }],
      count: { value: 4, exact: true },
    },
  });
  const html = renderPage(oneUncounted);
  const sectionHtml = section(html, 'relation-groups');
  expect(countTextValues(sectionHtml)).toEqual(['4']);
  expect(countTextValues(groupBlock(html, 'order'))).toEqual([]);
  expect(countTextValues(groupBlock(html, 'world'))).toEqual(['4']);
});

test('the relations page omits an absent heading count and keeps its next page link', () => {
  const html = renderToString(
    createElement(RelationsView, {
      locale: 'en',
      subject: { id: subject, label: 'The subject' },
      frame: null,
      data: {
        property: null,
        body: {
          links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000101', property: 'wdt:P155', label: 'Sequel' }],
          next: 'opaque-cursor',
        },
      },
      relations: { 'wdt:P155': { label: 'Sequel', group: 'order', symmetric: false } },
      value: {
        locale: 'en',
        link: PlainLink,
        reader: defaultReader,
        labels,
        unlabelled: 'Unlabelled',
        spoilerShow: 'Show',
      },
    } as never),
  );
  const heading = /<div data-slot="view-heading"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  expect(countTextValues(heading)).toEqual([]);
  expect(html).toContain(`href="/en/subjects/${subject}/the-subject/relations?cursor=opaque-cursor"`);
  expect(html).toContain('data-slot="next-page"');
});

test('counted links keep their plain or plus count and never show less than returned items', () => {
  const cases = [
    { count: { value: 2, exact: true }, expected: ['2'] },
    { count: { value: 3, exact: false }, expected: ['3+'] },
    { count: { value: 1, exact: true }, expected: ['2'] },
  ];
  for (const current of cases) {
    const data = page([subjectList('works', 'schema:author', 2)], {
      'schema:author': links(current.count, null, 2),
    });
    expect(countTextValues(section(renderPage(data), 'subject-list'))).toEqual(current.expected);
  }
});
