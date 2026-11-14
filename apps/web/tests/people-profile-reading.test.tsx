import { afterEach, expect, mock, test } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient, type SubjectRead } from '@rezics/client';
import { planReads, platformRegistry } from '@rezics/composition';
import {
  peopleReadingFixture,
  peopleReadingId,
  peopleReadingIds,
  peopleReadingPage,
  peopleReadingPortraitIds,
  routes as peopleRoutes,
  selectPeopleReading,
} from '../src/kernel/fake/people-reading';
import { selectAnimeShowcase } from '../src/kernel/fake/anime-showcase';
import { anime, animeId, animeSynopsisDocument } from '../src/kernel/fixtures/anime-showcase';
import { peopleOverviewFamily } from '../src/features/pages/showcase-people/profile';
import type { SubjectPageData } from '../src/features/pages/subject';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage } = await import('../src/features/pages/subject');
const { subjectPageMessages } = await import('../src/features/pages/route-support');
const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
const { m } = await import('../src/paraglide/messages.js');
const families = ['character', 'person', 'organization'] as const;
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const biography = {
  character: 'Sora makes maps of a harbour',
  person: 'Mira Sato directs independent animated films',
  organization: 'Paper Lantern Studio is an independent animation workshop',
};
const exploration = { character: 'appearances', person: 'director', organization: 'production-company' };

afterEach(() => {
  selectPeopleReading();
  selectAnimeShowcase();
});

async function draw(page: SubjectPageData, locale = 'en') {
  const client = new QueryClient();
  const node = h(SubjectPage, { page, locale, messages: subjectPageMessages(locale), renderJsonLd: false });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  try {
    await router.load();
    return renderToStaticMarkup(h(QueryClientProvider, { client }, h(RouterProvider, { router })));
  } finally {
    client.clear();
  }
}

function leaf(page: SubjectPageData, node: string) {
  const plan = planReads(platformRegistry, page.document, {
    subject: page.subject,
    context: page.context,
    ...(page.continuation ? { continuation: page.continuation } : {}),
  });
  return page.reads[plan.nodes[node]!]!;
}

function publicRead(page: SubjectPageData) {
  const plan = planReads(platformRegistry, page.document, { subject: page.subject, context: page.context });
  const key = Object.entries(plan.reads).find(([, read]) => read.kind === 'subject')![0];
  return page.reads[key]!.body as SubjectRead;
}

test('all eight locales read identity, context, one native biography, works and discussion in order', async () => {
  for (const locale of locales) {
    for (const family of families) {
      const page = peopleReadingPage(peopleReadingIds[family], locale);
      const html = await draw(page, locale);
      const positions = [
        'data-slot="subject-header"',
        'data-slot="people-profile-context"',
        `data-slot="${family}-reader"`,
        `id="${exploration[family]}"`,
        'data-slot="thread-list"',
        'data-slot="reading-overview-tools"',
      ].map((marker) => html.indexOf(marker));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(html.split(biography[family])).toHaveLength(2);
      expect(html).toContain('The Harbour Letters');
      expect(html).toContain('How do the harbour stories connect?');
      expect(html).toContain('data-slot="people-profile-details"');
      expect(html).toContain(`/media/${peopleReadingPortraitIds[family]}/webp-`);
      expect(html).toContain(m.subject_details({}, { locale }));
      expect(html).not.toContain('data-slot="subject-summary"');
    }
  }
  // Account identity and the active work families retain their own composition.
  expect(peopleOverviewFamily('schema:Person', 'overview', true)).toBeUndefined();
  expect(peopleOverviewFamily('schema:Person', 'works', false)).toBeUndefined();
  expect(peopleOverviewFamily('schema:VideoGame', 'overview', false)).toBeUndefined();
  expect(peopleOverviewFamily('schema:TVSeries', 'overview', false)).toBeUndefined();
});

test('sparse profiles keep recognition and a real work without inventing optional facts or portraits', async () => {
  for (const family of families) {
    const page = peopleReadingPage(peopleReadingIds[family], 'en', 'overview', 'sparse');
    const html = await draw(page);
    expect(html).toContain(`data-people-family="${family}"`);
    expect(html).toContain('The Harbour Letters');
    expect(html).not.toContain(biography[family]);
    expect(html).not.toContain(`/media/${peopleReadingPortraitIds[family]}/`);
    expect(html).not.toContain('data-slot="character-reader-traits"');
    const primary = html.slice(0, html.indexOf('data-slot="people-profile-details"'));
    expect(primary).not.toContain('data-slot="person-reader-occupations"');
    expect(primary).not.toContain('data-slot="person-reader-languages"');
    if (family === 'person') {
      expect(html).toContain('data-slot="person-reader-occupations"');
      expect(html).toContain(m.people_biography_unsupported({}, { locale: 'en' }));
    }
    expect(html).not.toContain('170');
  }
});

test('each People portrait has its own media identity and correctly sized advertised WebP files', async () => {
  const { profiles } = peopleReadingFixture();
  expect(new Set(Object.values(peopleReadingPortraitIds)).size).toBe(3);
  for (const family of families) {
    const cover = profiles[family].summary!.cover!;
    expect(cover.media).toBe(peopleReadingPortraitIds[family]);
    expect(cover.media.startsWith('0193d000-')).toBe(true);
    expect([cover.width, cover.height]).toEqual([480, 600]);
    expect(cover.variants).toEqual([
      { format: 'webp', width: 160 },
      { format: 'webp', width: 320 },
    ]);
    for (const variant of cover.variants) {
      const bytes = Buffer.from(
        await Bun.file(
          new URL(`../.storybook/media/${cover.media}/webp-${variant.width}`, import.meta.url),
        ).arrayBuffer(),
      );
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.toString('ascii', 8, 16)).toBe('WEBPVP8 ');
      expect(bytes.readUInt16LE(26) & 0x3fff).toBe(variant.width);
      expect(bytes.readUInt16LE(28) & 0x3fff).toBe((variant.width * cover.height) / cover.width);
    }
  }
});

test('exact document admission, partial dates and withheld history survive the reading presentation', async () => {
  for (const family of families) {
    const page = peopleReadingPage(peopleReadingIds[family]);
    const read = publicRead(page);
    const candidate = read.subject.statements['schema:abstract']![0]!;
    const documents = structuredClone(read.documents!);
    documents[candidate.id] = { ...documents[candidate.id]!, candidateId: peopleReadingId(777) };
    read.documents = documents;
    const html = await draw(page);
    expect(html).not.toContain(biography[family]);
    expect(html).toContain('The Harbour Letters');
  }
  const person = await draw(peopleReadingPage(peopleReadingIds.person));
  expect(person).toContain('1988');
  expect(person).not.toContain('January 1');
  expect(person).toContain('Animation director');
  const organization = await draw(peopleReadingPage(peopleReadingIds.organization));
  expect(organization).toContain('Lantern Workshop');
  expect(organization).not.toContain(peopleReadingId(999));
  expect(organization).toContain('data-organization-property="wdt:P1365"');
});

test('each failed work stream retains its retry while native identity, biography and discussion stay readable', async () => {
  for (const family of families) {
    const page = peopleReadingPage(peopleReadingIds[family], 'en', 'overview', 'relation-failure');
    expect(leaf(page, exploration[family]).status).toBe(503);
    expect(leaf(page, 'threads').status).toBe(200);
    const html = await draw(page);
    expect(html).toContain(biography[family]);
    expect(html).toContain('data-slot="thread-list"');
    expect(html).toContain(m.subject_section_retry({}, { locale: 'en' }));
    expect(html).toContain('How do the harbour stories connect?');
  }
});

test('the routed native work continuation is finite and retains assertion identity, role, credited name and citation', async () => {
  selectPeopleReading();
  const kernel = createKernelClient('https://kernel.invalid', { fetch: createStoryRecordedKernelFetch() });
  const id = peopleReadingIds.person;
  const initial = await kernel.pages.$read.post({ target: { subject: id, view: 'works' }, languages: ['ja'] });
  expect(initial.status).toBe(200);
  const firstPage = initial.data as SubjectPageData;
  type Rows = {
    links: { subject: string; assertion: SubjectRead['subject']['statements'][string][number] }[];
    next: string | null;
  };
  const rows: Rows['links'] = [];
  let page = firstPage;
  let cursor: string | null;
  do {
    const part = leaf(page, 'credit-schema-director').body as Rows;
    expect(part.links.length).toBeLessThanOrEqual(8);
    rows.push(...part.links);
    cursor = part.next;
    if (cursor) {
      const next = await kernel.pages.$read.post({
        target: { subject: id, view: 'works' },
        languages: ['ja'],
        continuation: { node: 'credit-schema-director', cursor },
      });
      expect(next.status).toBe(200);
      page = next.data as SubjectPageData;
      expect(page.context).toEqual(firstPage.context);
    }
  } while (cursor);
  expect(rows).toHaveLength(23);
  expect(new Set(rows.map((row) => row.assertion.id)).size).toBe(23);
  expect(rows[0]!.assertion).toMatchObject({
    property: { id: 'schema:director' },
    value: { content: id },
    qualifiers: [{ property: { id: 'wdt:P1932' }, value: { content: 'M. Sato' } }],
    references: [{ parts: [{ value: { content: 'https://people-reading.example/catalogue' } }] }],
  });
  const voice = leaf(peopleReadingPage(id, 'en', 'works'), 'credit-wdt-P725').body as Rows;
  expect(voice.links[0]!.assertion.qualifiers).toMatchObject([
    { property: { id: 'wdt:P453' }, value: { content: peopleReadingIds.character } },
    { property: { id: 'wdt:P3831' }, value: { content: peopleReadingId(42) } },
  ]);
});

test('registered transport follows every People subject and exact document/discussion readback without Anime identity', async () => {
  const transport = createStoryRecordedKernelFetch();
  const kernel = createKernelClient('https://kernel.invalid', { fetch: transport });
  const get = async <Body,>(path: string, status = 200) => {
    const response = await transport(
      new Request(`https://kernel.invalid/v1/${path}`, { headers: { authorization: 'Bearer story-viewer' } }),
    );
    expect(response.status).toBe(status);
    return (await response.json()) as Body;
  };
  const pageFor = async (id: string) => {
    const response = await kernel.pages.$read.post({ target: { subject: id }, languages: ['en'] });
    expect(response.status).toBe(200);
    return response.data as SubjectPageData;
  };
  const fixture = peopleReadingFixture();
  const visits = new Map<string, SubjectPageData>();
  for (const [id, supplied] of fixture.subjects) {
    expect(id.startsWith('0193e000-')).toBe(true);
    const page = await pageFor(id);
    visits.set(id, page);
    expect(page.subject).toBe(id);
    expect(publicRead(page).subject).toEqual(supplied.subject);
    expect((await get<SubjectRead>(`subjects/${id}`)).subject).toEqual(supplied.subject);
  }
  const threadIds = new Set<string>();
  for (const family of families) {
    const current = fixture.profiles[family];
    const id = current.subject.id;
    const document = Object.values(current.documents!)[0]!;
    expect(document.id.startsWith('0193e000-')).toBe(true);
    expect(document.candidateId).toBe(peopleReadingId(90 + families.indexOf(family)));
    expect(await get(`documents/${document.id}`)).toMatchObject({ document });
    type Thread = { id: string; boardId: string; subjectIds: string[]; firstPost: { id: string; threadId: string } };
    const embedded = (leaf(await pageFor(id), 'threads').body as { threads: Thread[] }).threads[0]!;
    threadIds.add(embedded.id);
    expect(embedded.id.startsWith('0193e000-')).toBe(true);
    expect(await get(`subjects/${id}/threads?kind=discussion`)).toMatchObject({ threads: [embedded], next: null });
    expect(await get(`threads/${embedded.id}`)).toMatchObject({ thread: embedded });
    expect(await get(`threads/${embedded.id}/reading-page`)).toMatchObject({
      target: { threadId: embedded.id, boardId: embedded.boardId },
      thread: embedded,
    });
    expect(await get(`threads/${embedded.id}/posts`)).toMatchObject({ posts: [embedded.firstPost], next: null });
    expect(await get(`boards/${embedded.boardId}`)).toMatchObject({ board: { id: embedded.boardId } });
    expect(await get(`boards/${embedded.boardId}/page`)).toMatchObject({
      board: { id: embedded.boardId },
      threads: expect.arrayContaining([expect.objectContaining({ thread: embedded })]),
    });
  }
  expect(threadIds.size).toBe(3);
  selectAnimeShowcase('rich');
  expect(publicRead(await pageFor(anime.id)).subject.labels.en).toBe(anime.label);
  expect(await get(`documents/${animeId(90)}`)).toMatchObject({ document: animeSynopsisDocument() });
  expect(await get(`progressSessions?subjectId=${anime.id}`)).toMatchObject({
    progressSessions: [{ subjectId: anime.id, amount: '3' }],
  });
  const question = '00000000-0000-7000-8000-000000000001';
  expect(await get(`subjects/${anime.id}/ratings/${question}/vote`)).toMatchObject({ units: 17 });
  selectPeopleReading('sparse');
  expect(publicRead(await pageFor(peopleReadingIds.character)).summary!.cover).toBeNull();
  selectPeopleReading();
  for (const family of families) {
    const id = peopleReadingIds[family];
    const page = await pageFor(id);
    expect(page.context).toEqual(visits.get(id)!.context);
    expect(publicRead(page).subject).toEqual(fixture.profiles[family].subject);
    expect(publicRead(page).summary!.cover!.media).toBe(peopleReadingPortraitIds[family]);
    expect(await get(`libraryEntries/${id}`, 404)).toMatchObject({ code: 'not_found' });
    expect(await get(`subjects/${id}/ratings/${question}/vote`, 404)).toMatchObject({ code: 'not_found' });
    expect(await get(`progressSessions?subjectId=${id}`)).toMatchObject({ progressSessions: [], next: null });
    expect(await get(`accounts?agent=${id}`)).toMatchObject({ accounts: [], next: null });
  }
});

test('People handlers decline Anime and unallocated identities rather than claiming their prefix or resource kind', async () => {
  const paths = [
    `subjects/${anime.id}`,
    `subjects/${anime.id}/links?property=schema:director`,
    `subjects/${anime.id}/relations?property=schema:director`,
    `documents/${animeId(90)}`,
    `subjects/${peopleReadingId(999)}`,
    `subjects/${peopleReadingId(80)}`,
    `documents/${peopleReadingIds.character}`,
    `threads/${animeId(20051)}/reading-page`,
    `threads/${peopleReadingId(99999)}`,
    `boards/${animeId(81)}`,
    `libraryEntries/${anime.id}`,
    `progressSessions?subjectId=${anime.id}`,
    `accounts?agent=${anime.id}`,
  ];
  const requests = paths.map((path) => new Request(`https://kernel.invalid/v1/${path}`));
  for (const id of [anime.id, peopleReadingId(999), peopleReadingId(80)]) {
    requests.push(
      new Request('https://kernel.invalid/v1/pages:read', {
        method: 'POST',
        body: JSON.stringify({ target: { subject: id } }),
      }),
    );
  }
  for (const request of requests) {
    for (const route of peopleRoutes) {
      if (route.method !== request.method) continue;
      const path = new URL(request.url).pathname;
      const match = route.path instanceof RegExp ? route.path.exec(path) : null;
      if (typeof route.path === 'string' ? route.path !== path : !match) continue;
      expect(await route.story!({ request: request.clone() as Request, recordings: {}, match })).toBeUndefined();
    }
  }
});
