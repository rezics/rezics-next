import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { slug } from '@rezics/definitions/slug';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { readRelationsPage, RelationsView } from '../src/features/pages/relations-view.tsx';
import { PlainLink } from '../src/features/pages/shared.tsx';
import { loadViewPages, SubjectFrame, subjectFrame, SubjectViewPage } from '../src/features/pages/subject-frame.tsx';
import type { SubjectPageData } from '../src/features/pages/subject.tsx';
import type { ViewTabLabels } from '../src/features/pages/view-tabs.tsx';
import { subjectTabs } from '../src/features/pages/views.ts';
import { defaultReader } from '../src/subject/reader.ts';

const kokoro = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const sent: string[] = [];
const local = createFakeKernelFetch(fixtures as never);
const client = createKernelClient('https://kernel.invalid', {
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push(`${request.method} ${new URL(request.url).pathname}`);
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
    posts: 'Posts',
    reviews: 'Reviews',
    discussion: 'Discussion',
    lists: 'Lists',
    collections: 'Collections',
    details: 'Details',
  },
};
const coverLabels = { withheld: 'Withheld', reveal: 'Reveal', credit: 'Credit', via: 'via' };
const overviewHref = `/en/subjects/${kokoro}/${slug('The Little Prince')}`;

/** The overview page with its subject read replaced by a subject that has an original title, a date and a cover. */
function withSubject(page: SubjectPageData): SubjectPageData {
  const reads = structuredClone(page.reads);
  const key = Object.keys(reads).find((name) => {
    const body = reads[name]?.body as { subject?: { id?: string } } | undefined;
    return body?.subject?.id === kokoro;
  })!;
  const body = reads[key]!.body as { subject: Record<string, unknown>; summary?: unknown };
  const statement = (property: string, content: unknown) => ({
    id: `${property}-1`,
    rank: 'normal',
    property: { id: property, data_type: property === 'schema:name' ? 'monolingualtext' : 'time' },
    value: { type: 'value', content },
    qualifiers: [],
    references: [],
  });
  body.subject.labels = { en: 'The Little Prince', ja: 'こころ' };
  body.subject.statements = {
    'schema:name': [statement('schema:name', { text: 'こころ', language: 'ja' })],
    'schema:datePublished': [
      statement('schema:datePublished', { time: '+1914-04-20T00:00:00Z', precision: 11, calendarmodel: 'x' }),
    ],
  };
  body.summary = { id: kokoro, type: 'schema:Book', types: ['schema:Book'], cover: null };
  return { ...page, reads };
}

const overviewOf = async () => {
  const result = await client.pages.$read.post({ target: { subject: kokoro } });
  return withSubject(result.data as unknown as SubjectPageData);
};

const frameFor = (page: SubjectPageData, view: Parameters<typeof SubjectFrame>[0]['view']) => {
  const frame = subjectFrame(page, 'en');
  if (!frame) throw new Error('expected a frame');
  return createElement(SubjectFrame, {
    frame,
    locale: 'en',
    link: PlainLink,
    reader: defaultReader,
    coverLabels,
    unlabelled: 'Unlabelled subject',
    typeLabel: 'Book',
    tabs: subjectTabs(page),
    tabLabels: labels,
    view,
  });
};

const linksBody = {
  links: [
    {
      subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02',
      property: 'wdt:P155',
      statement: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e22',
      label: 'Sequel to Kokoro',
      type: 'schema:Book',
      summary: null,
    },
  ],
  count: { value: 5, exact: true },
  next: null,
};

const relationsHtml = (page: SubjectPageData) =>
  renderToString(
    createElement(RelationsView, {
      locale: 'en',
      subject: kokoro,
      frame: frameFor(page, 'relations'),
      data: { body: linksBody, property: null },
      relations: { 'wdt:P155': { label: 'Sequel', group: 'order', symmetric: false } },
      value: {
        locale: 'en',
        link: PlainLink,
        reader: defaultReader,
        labels: { spoilerShow: 'Show', documentSpoiler: 'Reveal', cover: coverLabels },
        unlabelled: 'Unlabelled subject',
        spoilerShow: 'Show',
      },
    } as never),
  );

async function viewHtml(overview: SubjectPageData, view: Parameters<typeof SubjectFrame>[0]['view']) {
  const result = await client.pages.$read.post({ target: { subject: kokoro, view: view as never } });
  const page = result.data as unknown as SubjectPageData;
  return renderToString(
    createElement(SubjectViewPage, {
      page,
      locale: 'en',
      messages,
      view,
      frame: frameFor(overview, view),
      label: labels.names[view],
      renderJsonLd: false,
    } as never),
  );
}

const header = (html: string) => /<header[^>]*data-slot="subject-header"[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
const tabLinks = (html: string) =>
  [...(/<nav[^>]*data-slot="view-tabs"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '').matchAll(/href="([^"]+)"/g)].map(
    (match) => match[1],
  );

test('every subject view URL renders the compact subject header: xs cover, title linking to the overview, original title, type and date', async () => {
  const overview = await overviewOf();
  const views = subjectTabs(overview)
    .map((tab) => tab.view)
    .filter((view) => view !== 'overview' && view !== 'relations');
  expect(views.length).toBeGreaterThan(0);
  const pages = [...(await Promise.all(views.map((view) => viewHtml(overview, view)))), relationsHtml(overview)];
  for (const html of pages) {
    const head = header(html);
    expect(head).not.toBe('');
    expect(head).toMatch(/data-slot="cover"[^>]*data-size="xs"|data-size="xs"[^>]*data-slot="cover"/);
    expect(head).toMatch(new RegExp(`<a[^>]*href="${overviewHref}"[^>]*>The Little Prince</a>`));
    expect(head).toMatch(/<[a-z]+[^>]*lang="ja"[^>]*>こころ</);
    expect(head).toContain('Book');
    expect(head).toContain('April 20, 1914');
    // No summary, reactions or library controls: those stay on the overview.
    expect(head).not.toContain('<button');
    // The view's own heading follows the frame, and the bare back link is gone.
    expect(html.indexOf('data-slot="subject-header"')).toBeLessThan(html.search(/<h1[^>]*>/));
    expect(html.match(new RegExp(`<a[^>]*href="${overviewHref}"[^>]*>The Little Prince</a>`, 'g'))).toHaveLength(1);
  }
  expect(pages.at(-1)).toMatch(/<h1[^>]*>Relations<\/h1>/);
  expect(pages.at(-1)).toContain('>5</span>');
});

test('every subject view renders the same sticky view tabs as the overview with the current view marked active', async () => {
  const overview = await overviewOf();
  const tabs = subjectTabs(overview);
  const reference = tabLinks(renderToString(frameFor(overview, 'overview')));
  expect(reference.length).toBe(tabs.length);
  for (const { view } of tabs.filter((tab) => tab.view !== 'overview')) {
    const html = view === 'relations' ? relationsHtml(overview) : await viewHtml(overview, view);
    const nav = /<nav[^>]*data-slot="view-tabs"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect(nav).toContain('sticky');
    expect(tabLinks(html)).toEqual(reference);
    const current = [...nav.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)];
    expect(current).toHaveLength(1);
    expect(current[0]![0]).toContain(`href="${overviewHref}/${view}"`);
    const count = tabs.find((tab) => tab.view === view)?.count;
    if (count)
      expect(nav).toContain(
        `data-slot="count" class="text-xs tabular-nums">${count.value}${count.relation === 'lower_bound' ? '+' : ''}`,
      );
  }
});

test('the compact header and tabs render without JavaScript and add no kernel read beyond what the view already makes', async () => {
  // A view page reads the view and the overview, as before; the frame is built from the overview it already holds.
  sent.length = 0;
  const loaded = await loadViewPages(client, kokoro, 'details');
  expect(loaded.kind).toBe('page');
  expect(sent).toEqual(['POST /v1/pages:read', 'POST /v1/pages:read']);

  // The relations view swaps its subject read for the overview page read: the same two requests as before.
  sent.length = 0;
  const relations = await readRelationsPage(client, { id: kokoro });
  expect(relations.overview.kind).toBe('page');
  expect(sent).toHaveLength(2);
  expect(sent.filter((request) => request.startsWith('GET /v1/subjects/') && request.endsWith('/links'))).toHaveLength(
    1,
  );
  expect(sent.filter((request) => request.startsWith('POST /v1/pages:read'))).toHaveLength(1);

  // Building the frame and drawing it reads nothing more, and the server-rendered markup holds all of it.
  sent.length = 0;
  const overview = await overviewOf();
  const before = sent.length;
  const html = renderToString(frameFor(overview, 'details'));
  expect(sent).toHaveLength(before);
  expect(html).toContain('data-slot="subject-header"');
  expect(html).toContain('data-slot="view-tabs"');
  expect(html).not.toContain('<script');
});
