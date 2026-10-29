import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { slug } from '@rezics/definitions/slug';
import { fromMarkdown } from '@rezics/document';
import {
  definedViews,
  planReads,
  platformRegistry,
  resolveView,
  templateViews,
  VIEWS,
  type PresentationProfile,
} from '@rezics/composition';
import platformJson from '@rezics/composition/profiles/platform.json';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { loadSubjectPage, SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import { subjectTabs } from '../src/features/pages/views.ts';
import { loadViewPages } from '../src/features/pages/subject-frame.tsx';
import type { ViewTabLabels } from '../src/features/pages/view-tabs.tsx';

const platform = platformJson as unknown as PresentationProfile;
const kokoro = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const mushishi = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
const nikujaga = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const path = (id: string, label: string, view?: string) => `/en/subjects/${id}/${slug(label)}${view ? `/${view}` : ''}`;
const sent: string[] = [];
const local = createFakeKernelFetch(fixtures as never);
const client = createKernelClient('https://kernel.invalid', {
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push(
      `${request.method} ${new URL(request.url).pathname} ${request.method === 'POST' ? await request.clone().text() : ''}`,
    );
    return local(request);
  }) as typeof fetch,
});
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled subject',
  sources: 'Sources',
  aliases: 'Also known as',
  details: 'Details',
};
const labels: ViewTabLabels = {
  views: 'Subject views',
  names: {
    overview: 'Overview',
    editions: 'Editions',
    contents: 'Contents',
    characters: 'Characters',
    appearances: 'Appearances',
    credits: 'Credits',
    works: 'Works',
    relations: 'Relations',
    reviews: 'Reviews',
    discussion: 'Discussion',
    lists: 'Lists',
    details: 'Details',
  },
};
const loaded = async (id: string, view?: Parameters<typeof loadSubjectPage>[2]) => {
  const result = await loadSubjectPage(client, id, view);
  if (result.kind !== 'page') throw new Error(`expected a page, got ${result.kind}`);
  return result.page;
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const section = (html: string, slot: string) =>
  new RegExp(`<section[^>]*data-slot="${slot}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';

test("each subject view is its own server-rendered URL under the subject's address, resolved from the template's per-view documents with generic fallback", async () => {
  // The route is a sibling of the overview route, so a view lives at /subjects/<id>/<slug>/<view>.
  const route = await Bun.file(
    join(import.meta.dir, '..', 'src', 'routes', 'subjects', '$id_.$slug_.$view.tsx'),
  ).text();
  expect(route).toContain("createFileRoute('/subjects/$id_/$slug_/$view')");
  expect(route).toContain('loadViewPages(client, data.id, data.view, data.locale)');

  sent.length = 0;
  const details = await loaded(kokoro, 'details');
  expect(sent).toEqual([
    `POST /v1/pages:read ${JSON.stringify({ target: { subject: kokoro, view: 'details' }, languages: ['en'] })}`,
  ]);
  const work = platform.bases.find(({ base }) => base === 'schema:CreativeWork')!;
  expect(details.template).toEqual({
    scope: 'base',
    key: 'schema:CreativeWork',
  });
  expect(details.document).toEqual(templateViews(work).details);
  expect(details.views).toEqual(
    definedViews(platform, {
      type: 'schema:Book',
      bases: ['schema:CreativeWork', 'schema:Thing'],
    }),
  );

  // Both documents used by the view route ask for the page's language chain.
  sent.length = 0;
  expect((await loadViewPages(client, kokoro, 'details', 'zh-Hans')).kind).toBe('page');
  expect(sent).toEqual([
    `POST /v1/pages:read ${JSON.stringify({ target: { subject: kokoro, view: 'details' }, languages: ['zh-Hans', 'zh', 'zh-Hant'] })}`,
    `POST /v1/pages:read ${JSON.stringify({ target: { subject: kokoro }, languages: ['zh-Hans', 'zh', 'zh-Hant'] })}`,
  ]);

  // A template that lacks the view yields to the next in the order, then to the generic view.
  const generic = resolveView(platform, { type: 'schema:Recipe' }, 'relations');
  expect(generic).toMatchObject({ scope: 'generic', key: null });
  expect(generic!.document).toEqual(templateViews(platform.generic).relations!);
  expect(resolveView(platform, { type: 'schema:Person' }, 'works')).toMatchObject({
    scope: 'type',
    key: 'schema:Person',
  });
  expect(resolveView(platform, { type: 'schema:Person' }, 'editions')).toBeNull();
  // A view no template defines is not found.
  expect(
    (
      await client.pages.$read.post({
        target: { subject: nikujaga, view: 'works' },
      })
    ).status,
  ).toBe(404);

  // Every view renders on the server under its own address, with its own heading and the same tab bar.
  const overview = await loaded(kokoro);
  const tabs = subjectTabs(overview);
  for (const { view } of tabs.filter((tab) => tab.view !== 'overview')) {
    const page = await loaded(kokoro, view);
    const html = renderToString(
      createElement(SubjectPage, {
        page,
        locale: 'en',
        messages,
        view,
        tabs,
        tabLabels: labels,
        heading: {
          title: 'Kokoro',
          label: labels.names[view],
          href: path(kokoro, 'Kokoro'),
        },
        renderJsonLd: false,
      } as never),
    );
    expect(html).toMatch(new RegExp(`<h1[^>]*>${labels.names[view]}</h1>`));
    expect(html).toContain(`href="${path(kokoro, 'Kokoro')}"`);
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*aria-selected="true"[^>]*href="${path(kokoro, 'Kokoro', view)}"|href="${path(kokoro, 'Kokoro', view)}"[^>]*aria-selected="true"`,
      ),
    );
  }
  const html = renderToString(
    createElement(SubjectPage, {
      page: details,
      locale: 'en',
      messages,
      view: 'details',
      tabs,
      tabLabels: labels,
      heading: {
        title: 'Kokoro',
        label: 'Details',
        href: path(kokoro, 'Kokoro'),
      },
      renderJsonLd: false,
    } as never),
  );
  expect(text(html)).toContain('number of pages');
});

const subjectBody = {
  subject: {
    id: kokoro,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:0',
    context: '00000000-0000-8000-8000-000000000000',
    resolution: {},
    labels: { en: 'The Little Prince' },
    descriptions: {},
    aliases: {},
    statements: {
      'schema:abstract': [
        {
          id: '01a1740d-7480-71e4-841f-000000000002',
          rank: 'normal',
          property: { id: 'schema:abstract', data_type: 'document' },
          value: {
            type: 'value',
            content: {
              language: 'en',
              document: fromMarkdown('A pilot meets a prince.', 'text'),
            },
          },
          qualifiers: [],
          references: [],
          rezics: { release: 'sha256:0', revision: 1 },
        },
      ],
      'schema:character': [
        {
          id: '01a1740d-7480-71e4-841f-000000000001',
          rank: 'normal',
          property: { id: 'schema:character', data_type: 'wikibase-item' },
          value: {
            type: 'value',
            content: '01a1740d-7480-71e4-841f-66c04022d7c0',
          },
          qualifiers: [],
          references: [],
          rezics: { release: 'sha256:0', revision: 1 },
        },
      ],
    },
  },
  related: {
    '01a1740d-7480-71e4-841f-66c04022d7c0': { labels: { en: 'The Fox' } },
  },
};
const holder = (n: number) => ({
  subject: `01a1740d-7480-71e4-841f-${String(n).padStart(12, '0')}`,
  property: 'rezics:sideStoryOf',
  statement: `01a1740d-7480-71e4-841f-${String(n + 1000).padStart(12, '0')}`,
  label: `Side ${n}`,
  type: 'schema:Book',
  summary: null,
});
const edition = (n: number) => ({
  ...holder(n + 3000),
  property: 'schema:exampleOfWork',
  label: `Edition ${n}`,
});

/** A work overview whose reads return data for editions, one relation group, characters and lists. */
function workPage(options: { editions?: number; relations?: number; lists?: number } = {}): SubjectPageData {
  const { editions = 3, relations = 2, lists = 9 } = options;
  const document = templateViews(platform.bases.find(({ base }) => base === 'schema:CreativeWork')!).overview!;
  const plan = planReads(platformRegistry, document, { subject: kokoro });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') reads[key] = { status: 200, body: subjectBody };
    else if (read.kind === 'links') {
      const count =
        read.property === 'rezics:sideStoryOf' ? relations : read.property === 'schema:exampleOfWork' ? editions : 0;
      reads[key] = {
        status: 200,
        body: {
          links: Array.from({ length: count }, (_, index) =>
            read.property === 'schema:exampleOfWork' ? edition(index + 1) : holder(index + 1),
          ),
          count: { value: count, exact: true },
          next: null,
        },
      };
    } else if (read.kind === 'collections')
      reads[key] = {
        status: 200,
        body: {
          collections: Array.from({ length: Math.min(lists, 6) }, (_, index) => ({
            id: `01a1740d-7480-71e4-841f-${String(index + 2000).padStart(12, '0')}`,
            curator: { id: 'a', handle: 'reader', displayName: null },
            title: `Shelf ${index + 1}`,
            multiplicity: 1,
          })),
          count: { value: lists, exact: true },
          next: null,
        },
      };
  }
  return {
    subject: kokoro,
    profile: 'sha256:0',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: document as never,
    views: definedViews(platform, {
      type: 'schema:Book',
      bases: ['schema:CreativeWork'],
    }),
    reads,
  };
}
const renderOverview = (page: SubjectPageData, invitation?: string) =>
  renderToString(
    createElement(SubjectPage, {
      page,
      locale: 'en',
      messages,
      tabs: subjectTabs(page),
      tabLabels: labels,
      renderJsonLd: false,
      ...(invitation ? { invitation } : {}),
    } as never),
  );

test('the host renders a tab bar of the views that have data in the documented order, with counts, scrolling on phones without wrapping', () => {
  const page = workPage();
  const tabs = subjectTabs(page);
  // Views whose previews do not fit stay tabbed; Reviews, Discussion and Details are always there.
  expect(tabs.map(({ view }) => view)).toEqual(['overview', 'reviews', 'discussion', 'lists', 'details']);
  expect(tabs.map(({ view }) => VIEWS.indexOf(view))).toEqual(
    tabs.map(({ view }) => VIEWS.indexOf(view)).sort((a, b) => a - b),
  );
  expect(tabs.find(({ view }) => view === 'editions')).toBeUndefined();
  expect(tabs.find(({ view }) => view === 'lists')!.count).toEqual({
    value: 9,
    exact: true,
  });
  expect(tabs.find(({ view }) => view === 'reviews')).toBeUndefined();
  expect(tabs.find(({ view }) => view === 'discussion')).toBeUndefined();

  const html = renderOverview(page);
  const bar = /<nav[^>]*data-slot="view-tabs"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  expect(bar).toContain('aria-label="Subject views"');
  const hrefs = [...bar.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  expect(hrefs).toEqual([
    path(kokoro, 'The Little Prince'),
    ...['reviews', 'discussion', 'lists', 'details'].map((view) => path(kokoro, 'The Little Prince', view)),
  ]);
  expect(bar.match(/role="tab"/g)).toHaveLength(5);
  expect(bar).toMatch(
    /aria-selected="true"[^>]*href="[^"]*\/subjects\/[^"/]+\/[^"/]+"|href="[^"]*\/subjects\/[^"/]+\/[^"/]+"[^>]*aria-selected="true"/,
  );
  expect(text(bar)).not.toContain('Editions 3');
  expect(text(bar)).toContain('Lists 9');
  expect(text(bar)).toContain('Details');
  // The bar scrolls sideways on a narrow screen and never wraps; it stays in view under the top bar.
  expect(bar).toContain('overflow-x-auto');
  expect(bar).toContain('flex-nowrap');
  expect(bar).not.toContain('flex-wrap');
  expect(bar).toContain('whitespace-nowrap');
  expect(bar).toMatch(/class="[^"]*sticky top-16/);
  // It follows the template's header, before any section.
  expect(html.indexOf('data-slot="view-tabs"')).toBeGreaterThan(html.indexOf('</header>'));
  expect(html.indexOf('data-slot="view-tabs"')).toBeLessThan(
    html.indexOf('data-slot="subject-summary"') >>> 0 || html.length,
  );

  // Empty views, previews that fit in the overview, and views the templates do not define are left out.
  const bare = subjectTabs(workPage({ editions: 0, relations: 0, lists: 0 }));
  expect(bare.map(({ view }) => view)).toEqual(['overview', 'reviews', 'discussion', 'details']);
  const person = subjectTabs({
    ...workPage(),
    views: ['overview', 'works', 'discussion', 'details'],
  });
  expect(person.map(({ view }) => view)).toEqual(['overview', 'details']);
});

test('the platform overview follows the documented section order, ends with Sources and a Details link, and Details holds the remaining facts', async () => {
  for (const entry of [platform.generic, ...platform.bases, ...platform.types]) {
    const views = templateViews(entry);
    const overview = views.overview!.content.map((node) => node.type);
    expect(overview.at(-1)).toBe('Sources');
    expect(overview).not.toContain('MoreStatements');
    expect(views.details!.content.map((node) => node.type)).toContain('MoreStatements');
  }
  const work = templateViews(platform.bases.find(({ base }) => base === 'schema:CreativeWork')!);
  const order = work.overview!.content.map((node) => node.type);
  const at = (type: string) => order.indexOf(type);
  expect([
    at('Slot'),
    at('Summary'),
    at('Statements'),
    at('SubjectList'),
    at('RelationGroups'),
    at('Appearances'),
    at('Credits'),
  ]).toEqual([0, 1, 2, 3, 4, 8, 9]);
  expect(order.slice(10)).toEqual(['RatingSummary', 'ReviewList', 'ThreadList', 'CollectionList', 'Sources']);

  const html = renderOverview(workPage());
  const slots = [
    'subject-summary',
    'subject-list',
    'relation-groups',
    'appearances',
    'collection-list',
    'subject-sources',
  ].map((slot) => html.indexOf(`data-slot="${slot}"`));
  expect(slots).not.toContain(-1);
  expect(slots).toEqual([...slots].sort((a, b) => a - b));
  // The platform has no Reviews or Discussion read yet; this fixture cannot open those sections.
  // Ratings likewise need route data, which this composition-only fixture does not provide.
  for (const slot of ['rating-summary', 'review-list', 'thread-list'])
    expect(html).not.toContain(`data-slot="${slot}"`);
  const sources = section(html, 'subject-sources');
  expect(sources).toContain(`href="${path(kokoro, 'The Little Prince', 'details')}"`);
  expect(html.lastIndexOf('<section')).toBe(html.indexOf(sources));
  // Previews link to the full views of their sections.
  expect(section(html, 'collection-list')).toContain(`href="${path(kokoro, 'The Little Prince', 'lists')}"`);

  // The remaining facts are in Details, not in the overview.
  const overview = await loaded(kokoro);
  const details = await loaded(kokoro, 'details');
  const shown = (page: SubjectPageData, view: 'overview' | 'details') =>
    text(
      renderToString(
        createElement(SubjectPage, {
          page,
          locale: 'en',
          messages,
          view,
          ...(view === 'details' ? { heading: { title: 'Kokoro', label: 'Details', href: '/en' } } : {}),
          renderJsonLd: false,
        } as never),
      ),
    );
  expect(shown(overview, 'overview')).not.toContain('number of pages');
  expect(shown(details, 'details')).toContain('number of pages');
});

test('a subject with only a title renders a complete page with the placeholder cover, an invitation to add facts and Discussion', async () => {
  const page = await loaded(mushishi);
  expect(page.subject).toBe(mushishi);
  const tabs = subjectTabs(page);
  expect(tabs.map(({ view }) => view)).toEqual(['overview', 'reviews', 'discussion', 'details']);
  const html = renderToString(
    createElement(SubjectPage, {
      page,
      locale: 'en',
      messages,
      tabs,
      tabLabels: labels,
      invitation: 'Add what you know.',
      renderJsonLd: false,
    } as never),
  );
  expect(html).toMatch(/<h1[^>]*>Mushishi<\/h1>/);
  // The designed placeholder stands in for the cover.
  expect(html).toMatch(/data-slot="cover"/);
  expect(html).not.toContain('<img');
  expect(text(html)).toContain('Add what you know.');
  expect(html).toContain('data-slot="invitation"');
  expect(text(section(html, 'thread-list'))).toContain('Discussion');
  expect(html).toContain(`href="${path(mushishi, 'Mushishi', 'discussion')}"`);
  expect(html).toContain(`href="${path(mushishi, 'Mushishi', 'details')}"`);
  // Nothing raw: no identifier or property CURIE is shown.
  expect(text(html.replace(/<(?:a|link)\b[^>]*>/g, '<a>'))).not.toMatch(/schema:|wdt:|rezics:|0192f3a0/);
  // A subject with facts is not invited to add the first ones.
  const full = renderToString(
    createElement(SubjectPage, {
      page: await loaded(kokoro),
      locale: 'en',
      messages,
      invitation: 'Add what you know.',
      renderJsonLd: false,
    } as never),
  );
  expect(full).not.toContain('data-slot="invitation"');
});
