import { expect, test } from 'bun:test';
import { slug } from '@rezics/definitions/slug';
import { join } from 'node:path';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { VIEWS, type View } from '@rezics/composition';
import { agentAccount, avatarSummary, demoAgentSubjects } from '../src/kernel/agent-fixtures.ts';
import { createFakeKernelFetch, type FixtureAccount } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { agentPath, continueAgentList, loadAgentPage } from '../src/features/pages/agent.tsx';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import { subjectTabs } from '../src/features/pages/views.ts';
import type { ViewTabLabels } from '../src/features/pages/view-tabs.tsx';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${n.toString(16).padStart(12, '0')}`;
const statement = (property: string, content: string) => ({
  id: id(0x5000 + Math.floor(Math.random() * 0x0fff)),
  rank: 'normal',
  property: { id: property, data_type: 'wikibase-item' },
  value: { type: 'value', content },
  qualifiers: [],
  references: [],
});
const subject = (n: number, type: string, label: string, statements: Record<string, unknown[]> = {}) => ({
  id: id(n),
  type,
  labels: { en: label },
  descriptions: {},
  aliases: {},
  statements,
});

// A novelist verified as a catalogue person, with works and voice roles; a publisher verified as an organization.
const novelist = demoAgentSubjects[0]!.id;
const publisher = demoAgentSubjects[1]!.id;
const subjects = [
  ...fixtures.subjects,
  ...demoAgentSubjects,
  subject(0x6001, 'schema:Book', 'River Atlas', { 'schema:author': [statement('schema:author', novelist)] }),
  subject(0x6002, 'schema:Book', 'Salt Roads', { 'schema:author': [statement('schema:author', novelist)] }),
  subject(0x6003, 'wd:Q95074', 'Captain Ume', { 'wdt:P725': [statement('wdt:P725', novelist)] }),
  subject(0x6004, 'schema:Book', 'Paper Lanterns', { 'schema:publisher': [statement('schema:publisher', publisher)] }),
];
const accounts: FixtureAccount[] = [
  agentAccount(
    {
      id: id(0x7001),
      handle: 'mira',
      displayName: 'Mira Okabe',
      bio: 'Reads on trains. Keeps lists.',
      links: [
        { label: 'Reading journal', url: 'https://example.com/mira' },
        { label: 'Not a web link', url: 'javascript:alert(1)' },
      ],
      avatar: avatarSummary(1),
    },
    { reviews: 3, posts: 5, collections: 2 },
  ),
  // No avatar: the placeholder; no activity at all: no activity view.
  agentAccount({ id: id(0x7002), handle: 'plain', displayName: 'Plain Reader' }),
  agentAccount(
    {
      id: id(0x7003),
      handle: 'haruka',
      displayName: 'Haruka Aizawa',
      bio: 'Novelist and translator.',
      subject: novelist,
      avatar: avatarSummary(2),
    },
    { reviews: 5, posts: 6, collections: 5 },
  ),
  agentAccount(
    {
      id: id(0x7004),
      handle: 'lanternpress',
      kind: 'organization',
      displayName: 'Lantern Press',
      subject: publisher,
      avatar: avatarSummary(3),
      publicViews: { posts: true, reviews: false, collections: true },
    },
    { reviews: 2, posts: 2, collections: 1 },
  ),
  agentAccount(
    { id: id(0x7005), handle: 'prolific', displayName: 'Prolific' },
    { reviews: 25, posts: 30, collections: 30 },
  ),
  agentAccount({ id: id(0x7006), handle: 'ghost', state: 'deleted', displayName: 'Ghost' }, { posts: 1 }),
];

const sent: string[] = [];
const local = createFakeKernelFetch({ ...fixtures, subjects, accounts, admitted: ['collections'] } as never);
const client = createKernelClient('https://kernel.invalid', {
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    sent.push(
      `${request.method} ${url.pathname}${url.search} ${request.method === 'POST' ? await request.clone().text() : ''}`.trim(),
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
const labels: ViewTabLabels = { views: 'Agent views', names };

const loaded = async (handle: string, view?: View) => {
  const result = await loadAgentPage(client, handle, view);
  if (result.kind !== 'page') throw new Error(`expected a page for @${handle}, got ${result.kind}`);
  return result.page;
};
const render = (
  page: SubjectPageData,
  handle: string,
  view: View = 'overview',
  tabs?: ReturnType<typeof subjectTabs>,
  admitted = ['collections'],
) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['exposure', 'anonymous'], admitted);
  return renderToString(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(SubjectPage, {
        page,
        locale: 'en',
        messages,
        tabs: tabs ?? subjectTabs(page),
        tabLabels: labels,
        base: agentPath('en', handle),
        view,
        ...(view === 'overview'
          ? {}
          : { heading: { title: 'Agent', label: names[view], href: agentPath('en', handle) } }),
        renderJsonLd: false,
      } as never),
    }),
  );
};
const section = (html: string, slot: string) =>
  new RegExp(`<section[^>]*data-slot="${slot}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
const items = (html: string, slot: string) => (section(html, slot).match(/<li\b/g) ?? []).length;
const tabViews = (page: SubjectPageData) => subjectTabs(page).map((tab) => tab.view);

test("/@handle renders the agent's subject page, with the account's display name, avatar, bio and links in the header", async () => {
  sent.length = 0;
  const page = await loaded('mira');
  // One page read holds the handle read and the previews; nothing else is asked.
  expect(sent).toEqual([`POST /v1/pages:read ${JSON.stringify({ target: { account: 'mira' } })}`]);
  expect(page.account).toEqual({ id: id(0x7001), handle: 'mira' });
  // An unverified account still answers a subject page: its own agent node.
  expect(page.subject).toBe(id(0x7001));
  expect(page.template).toEqual({ scope: 'type', key: 'schema:Person' });

  const html = render(page, 'mira');
  const header = /<div[^>]*data-slot="agent-header"[\s\S]*?(?=<nav|<section)/.exec(html)?.[0] ?? '';
  expect(header).toMatch(/<h1[^>]*>Mira Okabe<\/h1>/);
  expect(header).toContain('@mira');
  expect(header).toContain('Reads on trains. Keeps lists.');
  // The avatar is a Cover at 1:1 whose image comes from the media route.
  expect(header).toContain('data-slot="cover"');
  expect(header).toContain(`/media/${avatarSummary(1).media}/webp-160`);
  // Only web links are links.
  expect(header).toContain('href="https://example.com/mira"');
  expect(header).toContain('Reading journal');
  expect(header).not.toContain('javascript:');
  // One heading: the account's presentation stands in for the subject's own header.
  expect(html.match(/<h1\b/g)).toHaveLength(1);

  // Without an avatar the frame shows its placeholder.
  const plain = render(await loaded('plain'), 'plain');
  expect(plain).toMatch(
    /data-slot="cover"[^>]*data-state="placeholder"|data-state="placeholder"[^>]*data-slot="cover"/,
  );
  expect(plain).toMatch(/<h1[^>]*>Plain Reader<\/h1>/);
});

test('an agent with an account offers Posts, Reviews and Collections views beside Works and Characters, each a bounded page with a continuation', async () => {
  const novelistPage = await loaded('haruka');
  expect(tabViews(novelistPage)).toEqual(['overview', 'posts', 'reviews', 'discussion', 'collections', 'details']);
  // The graph's views come from the subject; the others from the account.
  const overview = render(novelistPage, 'haruka');
  expect(overview).toContain('River Atlas');
  expect(overview).toContain('Captain Ume');
  // Each preview is bounded by its limit and links to its view.
  for (const [slot, view] of [
    ['account-posts', 'posts'],
    ['account-reviews', 'reviews'],
    ['account-collections', 'collections'],
  ] as const) {
    expect(items(overview, slot)).toBe(4);
    expect(section(overview, slot)).toContain(`href="/en/@haruka/${view}"`);
  }
  for (const view of ['posts', 'reviews', 'discussion', 'collections', 'details'] as const)
    expect(overview).toContain(`href="/en/@haruka/${view}"`);

  // A view is one bounded page of its list, and a continuation reads the rest through the list's own route.
  const prolific = await loaded('prolific');
  const prolificTabs = subjectTabs(prolific);
  for (const [view, slot, limit, total, route] of [
    ['posts', 'account-posts', 20, 30, 'posts'],
    ['reviews', 'account-reviews', 20, 25, 'threads'],
    ['collections', 'account-collections', 24, 30, 'collections'],
  ] as const) {
    sent.length = 0;
    const first = await loaded('prolific', view);
    expect(sent).toEqual([`POST /v1/pages:read ${JSON.stringify({ target: { account: 'prolific', view } })}`]);
    const firstHtml = render(first, 'prolific', view, prolificTabs);
    expect(items(firstHtml, slot)).toBe(limit);
    expect(firstHtml).toMatch(new RegExp(`<h1[^>]*>${names[view]}</h1>`));
    expect(firstHtml).toMatch(
      /data-slot="continuation"[^>]*href="\?cursor=c\d+"|href="\?cursor=c\d+"[^>]*data-slot="continuation"/,
    );
    const cursor = /href="\?cursor=([^"]+)"/.exec(firstHtml)![1]!;
    sent.length = 0;
    const next = await continueAgentList(client, first as never, decodeURIComponent(cursor));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`GET /v1/accounts/${id(0x7005)}/${route}?`);
    expect(sent[0]).toContain(`cursor=${cursor}`);
    expect(sent[0]).toContain(`limit=${limit}`);
    const nextHtml = render(next, 'prolific', view, prolificTabs);
    expect(items(nextHtml, slot)).toBe(total - limit);
    expect(nextHtml).not.toContain('data-slot="continuation"');
  }

  // A view is offered only with data, and only when the agent makes it public.
  expect(tabViews(await loaded('plain'))).toEqual(['overview', 'discussion', 'details']);
  const press = await loaded('lanternpress');
  expect(tabViews(press)).toEqual(['overview', 'discussion', 'details']);
  expect(render(press, 'lanternpress')).not.toContain('data-slot="account-reviews"');
  // Hiding a view hides only that list: the others stay.
  expect(items(render(press, 'lanternpress'), 'account-posts')).toBe(2);
  // A private view's own address answers an empty page, not the list.
  const hidden = await loaded('lanternpress', 'reviews');
  expect(items(render(hidden, 'lanternpress', 'reviews'), 'account-reviews')).toBe(0);
});

test("an account verified as a catalogue person or organization renders that subject's page at /@handle", async () => {
  const person = await loaded('haruka');
  expect(person.subject).toBe(novelist);
  expect(person.template).toEqual({ scope: 'type', key: 'schema:Person' });
  const personHtml = render(person, 'haruka');
  // The account presents itself; the graph's works and roles are the subject's statements on the same page.
  expect(personHtml).toMatch(/<h1[^>]*>Haruka Aizawa<\/h1>/);
  expect(personHtml).toContain('Novelist and translator.');
  expect(personHtml).toContain('River Atlas');
  expect(personHtml).toContain('Salt Roads');
  expect(personHtml).toContain('Captain Ume');
  expect(personHtml).toContain(`href="/en/subjects/${id(0x6001)}/${slug('River Atlas')}"`);

  const house = await loaded('lanternpress');
  expect(house.subject).toBe(publisher);
  expect(house.template).toEqual({ scope: 'type', key: 'schema:Organization' });
  const houseHtml = render(house, 'lanternpress');
  expect(houseHtml).toMatch(/<h1[^>]*>Lantern Press<\/h1>/);
  expect(houseHtml).toContain('Paper Lanterns');

  // The page is the same either way: an unverified agent has the same sections from its own node.
  expect(tabViews(await loaded('mira'))).toEqual(['overview', 'posts', 'reviews', 'discussion', 'details']);
});

test('an unknown handle, a reserved handle and a deleted account answer the same not-found page', async () => {
  sent.length = 0;
  const answers = await Promise.all(
    ['nobody', 'admin', 'ghost', '-bad', 'a'.repeat(65)].map((handle) => loadAgentPage(client, handle)),
  );
  // Whatever the reason, the answer is one missing page that names nothing about the handle.
  for (const answer of answers) expect(answer).toEqual({ kind: 'missing' });
  const views = await Promise.all(['nobody', 'ghost'].map((handle) => loadAgentPage(client, handle, 'posts')));
  for (const answer of views) expect(answer).toEqual({ kind: 'missing' });
  // The deleted account's activity stays out of reach.
  expect(sent.every((line) => !line.includes('/v1/accounts/'))).toBe(true);

  // Both routes turn a missing page into the site's not-found page, built from no handle.
  const actions = await Bun.file(join(import.meta.dir, '..', 'src', 'features', 'pages', 'agent-actions.ts')).text();
  expect(actions).toContain("result.kind === 'missing'");
  expect(actions).toContain('throw notFound()');
  for (const file of ['@{$handle}.tsx', '@{$handle}_.$view.tsx']) {
    const route = await Bun.file(join(import.meta.dir, '..', 'src', 'routes', file)).text();
    expect(route).toContain('readAgentPage(');
    expect(route).not.toContain('errorComponent');
    expect(route).not.toContain('notFoundComponent');
  }
});

test('an agent page is never routed inside a Realm or Zone', async () => {
  const routes = join(import.meta.dir, '..', 'src', 'routes');
  // The route sits at the top of the address space, and neither venue's routes name an agent page.
  expect(await Bun.file(join(routes, '@{$handle}.tsx')).exists()).toBe(true);
  expect(await Bun.file(join(routes, 'realms', '@{$handle}.tsx')).exists()).toBe(false);
  expect(await Bun.file(join(routes, 'spaces', '@{$handle}.tsx')).exists()).toBe(false);
  const route = await Bun.file(join(routes, '@{$handle}.tsx')).text();
  expect(route).toContain("createFileRoute('/@{$handle}')");
  expect(route).not.toMatch(/from '[^']*(community|realm|space)/i);
  expect(agentPath('en', 'mira')).toBe('/en/@mira');
  expect(agentPath('zh-Hans', 'mira', 'posts')).toBe('/zh-Hans/@mira/posts');
  expect(VIEWS).toContain('posts');

  // The page read names the account and nothing about a venue, and every link on the page stays on the site's
  // own address space: the agent's views, subjects, threads and collections.
  sent.length = 0;
  const page = await loaded('haruka');
  expect(sent).toEqual([`POST /v1/pages:read ${JSON.stringify({ target: { account: 'haruka' } })}`]);
  const html = render(page, 'haruka');
  const links = [...html.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1]!);
  expect(links.length).toBeGreaterThan(8);
  for (const link of links) {
    expect(link).toMatch(/^\/en\/(@haruka|subjects|threads|collections)(\/|$)/);
    expect(link).not.toMatch(/\/(realms|spaces)\//);
  }
});

test('a closed collections group hides the account collection continuation but keeps its public page content', async () => {
  const page = await loaded('prolific', 'collections');
  const html = render(page, 'prolific', 'collections', undefined, []);
  expect(items(html, 'account-collections')).toBe(24);
  expect(section(html, 'account-collections')).not.toContain('data-slot="continuation"');
  expect(section(html, 'account-collections')).not.toContain('/en/collections/');
});
