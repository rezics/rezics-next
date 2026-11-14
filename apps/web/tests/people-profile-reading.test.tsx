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
  selectPeopleReading,
} from '../src/kernel/fake/people-reading';
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

afterEach(() => selectPeopleReading());

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
    const plan = planReads(platformRegistry, page.document, { subject: page.subject, context: page.context });
    const key = Object.entries(plan.reads).find(([, read]) => read.kind === 'subject')![0];
    const read = page.reads[key]!.body as SubjectRead;
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
