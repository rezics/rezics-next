import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { loadSubjectPage, SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import type { RelationDefinition } from '../src/subject/relations.ts';
import { subjectTabs } from '../src/features/pages/views.ts';
import type { ViewTabLabels } from '../src/features/pages/view-tabs.tsx';

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80';
const relationProperty = 'rezics:sideStoryOf';

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

type List = { returned: number; count: number; exact: boolean };
type Lists = Partial<Record<'works' | 'characters' | 'editions' | 'relations', List>>;

function node(type: string, id: string, property: string, title?: string) {
  return {
    type,
    props: {
      id,
      property,
      limit: 2,
      ...(title ? { title: { en: title } } : {}),
      ...(type === 'Appearances' ? { direction: 'inverse' } : {}),
    },
  };
}

function overviewDocument(lists: Lists): CompositionDocument {
  const content = [];
  if (lists.works) content.push(node('SubjectList', 'works', 'schema:author', 'Works'));
  if (lists.characters) content.push(node('SubjectList', 'characters', 'wdt:P725', 'Characters'));
  if (lists.editions) content.push(node('SubjectList', 'editions', 'schema:exampleOfWork', 'Editions'));
  if (lists.relations) content.push(node('RelationGroups', 'relations', relationProperty));
  return { root: { props: {} }, content } as unknown as CompositionDocument;
}

function page(lists: Lists, options: { agent?: boolean; views?: string[]; document?: CompositionDocument } = {}) {
  const document = options.document ?? overviewDocument(lists);
  const account = options.agent ? { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81', handle: 'mira' } : undefined;
  const plan = planReads(platformRegistry, document, { subject, account: account ?? null });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind !== 'links') continue;
    const view =
      read.property === 'schema:author'
        ? 'works'
        : read.property === 'wdt:P725'
          ? 'characters'
          : read.property === 'schema:exampleOfWork'
            ? 'editions'
            : read.property === relationProperty
              ? 'relations'
              : undefined;
    const list = view ? lists[view] : undefined;
    const returned = list?.returned ?? 0;
    reads[key] = {
      status: 200,
      body: {
        links: Array.from({ length: returned }, (_, index) => ({
          subject: `0192f3a0-6c1e-7b2a-9d4e-${(0x100 + index).toString(16).padStart(12, '0')}`,
          property: read.property,
          label: `${view ?? 'List'} item ${index + 1}`,
        })),
        count: { value: list?.count ?? 0, exact: list?.exact ?? true },
        next: null,
      },
    };
  }
  return {
    subject,
    ...(account ? { account } : {}),
    profile: 'sha256:test',
    template: { scope: 'type' as const, key: 'schema:Book' },
    document,
    views: options.views ?? ['overview', 'works', 'characters', 'editions', 'relations', 'reviews', 'discussion', 'details'],
    reads,
  } satisfies SubjectPageData;
}

const relationDefinitions: Record<string, RelationDefinition> = {
  [relationProperty]: { label: 'Side story', group: 'derivation', symmetric: false },
};

function render(pageData: SubjectPageData, view: View = 'overview', tabs = subjectTabs(pageData)) {
  return renderToString(
    createElement(SubjectPage, {
      page: pageData,
      locale: 'en',
      messages,
      view,
      tabs,
      tabLabels,
      relations: relationDefinitions,
      ...(view === 'overview'
        ? {}
        : { heading: { title: 'The subject', label: names[view], href: `/en/subjects/${subject}` } }),
      ...(pageData.account ? { base: '/en/@mira' } : {}),
      renderJsonLd: false,
    } as never),
  );
}

function byId(html: string, id: string) {
  return new RegExp(`<section\\b[^>]*aria-labelledby="${id}-title"[\\s\\S]*?<\\/section>`).exec(html)?.[0] ?? '';
}

const rowCount = (section: string) => (section.match(/<li\b/g) ?? []).length;

test('an agent whose Characters and Works previews return every item has neither tab or See all link, and shows every item in the overview', () => {
  const agent = page(
    {
      works: { returned: 2, count: 2, exact: true },
      characters: { returned: 1, count: 1, exact: true },
    },
    { agent: true },
  );
  const tabs = subjectTabs(agent);
  expect(tabs.map(({ view }) => view)).not.toContain('works');
  expect(tabs.map(({ view }) => view)).not.toContain('characters');

  const html = render(agent);
  const works = byId(html, 'works');
  const characters = byId(html, 'characters');
  expect(rowCount(works)).toBe(2);
  expect(rowCount(characters)).toBe(1);
  expect(works).not.toContain('data-slot="see-all"');
  expect(characters).not.toContain('data-slot="see-all"');
  const tabsHtml = /<nav[^>]*data-slot="view-tabs"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  expect(tabsHtml).not.toContain('>Works<');
  expect(tabsHtml).not.toContain('>Characters<');
});

test('a subject view stays tabbed with its count and See all link when its preview is partial or inexact', () => {
  const complete = page({
    editions: { returned: 2, count: 2, exact: true },
    relations: { returned: 2, count: 2, exact: true },
  });
  const completeTabs = subjectTabs(complete);
  expect(completeTabs.map(({ view }) => view)).not.toContain('editions');
  expect(completeTabs.map(({ view }) => view)).not.toContain('relations');
  const completeHtml = render(complete);
  expect(rowCount(byId(completeHtml, 'editions'))).toBe(2);
  expect(rowCount(byId(completeHtml, 'relations'))).toBe(2);
  expect(byId(completeHtml, 'editions')).not.toContain('data-slot="see-all"');
  expect(byId(completeHtml, 'relations')).not.toContain('data-slot="see-all"');

  for (const list of [
    { returned: 2, count: 3, exact: true },
    { returned: 2, count: 2, exact: false },
  ]) {
    const partial = page({ editions: list, relations: list });
    const tabs = subjectTabs(partial);
    expect(tabs.find(({ view }) => view === 'editions')?.count).toEqual({ value: list.count, exact: list.exact });
    expect(tabs.find(({ view }) => view === 'relations')?.count).toEqual({ value: list.count, exact: list.exact });

    const html = render(partial);
    for (const id of ['editions', 'relations']) {
      const section = byId(html, id);
      expect(rowCount(section)).toBe(2);
      expect(section).toContain('data-slot="see-all"');
    }
  }
});

test('Overview, Reviews, Discussion and Details remain tabbed, and loading a view without a tab still renders it', async () => {
  const overview = page({ editions: { returned: 1, count: 1, exact: true } });
  const tabs = subjectTabs(overview);
  expect(tabs.map(({ view }) => view)).toEqual(['overview', 'reviews', 'discussion', 'details']);

  const viewDocument = {
    root: { props: {} },
    content: [node('SubjectList', 'editions', 'schema:exampleOfWork', 'Editions')],
  } as unknown as CompositionDocument;
  const viewData = page({ editions: { returned: 1, count: 1, exact: true } }, { document: viewDocument });
  const requests: unknown[] = [];
  const client = {
    pages: {
      $read: {
        post: async (request: unknown) => {
          requests.push(request);
          return { status: 200, data: viewData };
        },
      },
    },
  };
  const loaded = await loadSubjectPage(client as never, subject, 'editions');
  expect(loaded.kind).toBe('page');
  expect(requests).toEqual([{ target: { subject, view: 'editions' } }]);

  if (loaded.kind !== 'page') throw new Error('expected the view page');
  const html = render(loaded.page, 'editions', tabs);
  expect(html).toContain('<h1');
  expect(html).toContain('Editions</h1>');
  expect(byId(html, 'editions')).toContain('Editions item 1');
  expect(/<nav[^>]*data-slot="view-tabs"[\s\S]*?<\/nav>/.exec(html)?.[0]).not.toContain('data-view="editions"');
});
