import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EditableCollectionPage } from '../src/library/collection-load';
import recording from '../src/kernel/recorded/library-collection.json';
import memberRecording from '../src/kernel/recorded/library-collection-members.json';
import { subjectOf } from '../src/library/reads';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import { collectionStoryMembers } from '../src/kernel/fake/collection-stories';
import definitions from '../src/kernel/recorded/definitions-release.json';
import subjectRecording from '../src/kernel/recorded/subject.json';
import { defaultCoverRatio, parseListPresentation, placeholderColors } from '@rezics/ui/cover';
import { pickText } from '@rezics/composition';
import { coverSrc } from '../src/media/cover-src';
import { CollectionPresentationFields } from '../src/library/collection-editor';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionPage } = await import('../src/library/collection-page');

const page: EditableCollectionPage = {
  ...recording.collection,
  visibility: null,
  disclosedVisibility: 'public',
  memberCount: null,
  members: memberRecording.members.map((member) => ({ ...member, subject: subjectOf(member.subject) })),
  next: null,
  firstPage: true,
  following: false,
  publicExport: true,
  memberState: 'ready',
  presentationKind: null,
  presentationKindSource: 'mixed',
  cover: null,
  coverSource: 'pending',
  filterProperties: [{ id: 'schema:genre', label: 'Genre', datatype: 'wikibase-item' }],
  filterParams: { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] },
};

async function render(data = page, cursor?: string) {
  const route = createRootRoute({
    component: () =>
      createElement(CollectionPage, {
        page: data,
        queryKey: ['collection-page', data.id],
        refreshPage: async () => data,
        cursor,
        search: { type: 'schema:Book', 'f.schema:genre': ['novel', 'essay'] },
      }),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: [`/${getLocale()}/collections/${data.id}`] }),
  });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  } finally {
    client.clear();
  }
}

test('the editor offers mixed separately from automatic cover selection and retains retired explicit Types', () => {
  const previousLocale = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      for (const kind of [null, 'example:Retired']) {
        const html = renderToStaticMarkup(
          createElement(CollectionPresentationFields, {
            types: [{ id: 'schema:Book', label: 'Book' }],
            kind,
            onKindChange() {},
            coverMediaId: null,
            onCoverChange() {},
          }),
        );
        expect(html).toContain(m.library_collection_mixed_label());
        expect(html).toContain(m.library_collection_mixed_help());
        expect(html).toContain(m.library_collection_auto());
        expect(html).toContain(
          `<option value="${kind ?? ''}" selected="">${kind ?? m.library_collection_mixed_label()}</option>`,
        );
        expect(html).toContain('<option value="schema:Book">Book</option>');
      }
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});

test('The Collection identity keeps its own cover frame and shared placeholder when its own art is absent', async () => {
  // The SignedIn story measures the first real row and the single toolbar at phone390.
  // This render covers the same composition and disclosure in every launch locale.
  const previousLocale = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const html = await render();
      const hero = html.match(/<header\b[^>]*data-slot="collection-hero"[\s\S]*?<\/header>/)?.[0] ?? '';
      const toolbar = html.match(/<div\b[^>]*data-slot="collection-toolbar"[\s\S]*?<\/nav><\/div>/)?.[0] ?? '';
      expect(hero).toContain(recording.collection.title);
      expect(hero).toContain(recording.collection.curator.displayName);
      expect(hero).toContain(m.library_visibility_public());
      expect(hero).not.toContain(m.library_member_count({ count: 0 }));
      expect(hero).not.toContain(m.library_member_count({ count: 4 }));
      expect(hero).toContain('data-collection-cover-source="pending"');
      expect(hero).toContain('data-state="placeholder"');
      expect(hero).toContain(`data-ratio="${defaultCoverRatio}"`);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).not.toContain('data-library-navigation-phone');
      expect(html).not.toContain('data-library-navigation-desktop');
      expect(html).not.toContain(m.library_collection_social_unavailable());
      expect(html).not.toContain(m.library_collection_kind_pending());
      for (const label of [m.reaction_like(), m.library_subject_save(), m.report_action()])
        expect(html).not.toContain(renderToStaticMarkup(createElement('button', null, label)).slice(8, -9));
      expect(toolbar).toContain(`aria-label="${m.collection_filters()}"`);
      expect(toolbar.match(/<a\b/g)).toHaveLength(2);
      const links = [...toolbar.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
      for (const href of links) {
        const address = new URL(href, 'https://rezics.test');
        expect(address.searchParams.getAll('f.schema:genre')).toEqual(['novel', 'essay']);
        expect(address.searchParams.get('type')).toBe('schema:Book');
      }
      expect(html.indexOf('data-slot="collection-toolbar"')).toBeLessThan(html.indexOf('data-collection-members'));
      expect(html.match(/data-slot="member-list-row-title"/g)).toHaveLength(4);
      expect(html.indexOf('data-collection-members')).toBeLessThan(
        html.indexOf('aria-label="' + m.library_collection_export_label() + '"'),
      );
      expect(html).not.toContain('data-slot="member-list-row-facts"');
    }
    const title = '長い題名でも省略せずに読める本のコレクション — A long collection title without truncation';
    const html = await render({ ...page, title, memberCount: 4 });
    const heading = html.match(/<h1\b[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(heading).toContain(title);
    expect(heading).not.toMatch(/truncate|line-clamp/);
    expect(html).toContain(m.library_member_count({ count: 4 }));
  } finally {
    setLocale(previousLocale, { reload: false });
  }

  const ownCover = subjectOf(subjectRecording.summary)!.cover!;
  const member = collectionStoryMembers.find((member) => {
    const cover = member.subject.cover;
    return cover && cover.media !== ownCover.media;
  })!;
  expect(member.subject.cover).not.toBeNull();
  for (const cover of [ownCover, null, undefined]) {
    const html = await render({
      ...page,
      cover,
      coverSource: cover ? 'owner' : 'none',
      members: [{ ...member, subject: subjectOf(member.subject) }],
    });
    const hero = html.match(/<header\b[^>]*data-slot="collection-hero"[\s\S]*?<\/header>/)?.[0] ?? '';
    expect(hero.match(/data-slot="cover"/g)).toHaveLength(1);
    expect(hero).toContain('w-16 shrink-0 sm:w-24');
    expect(hero).toContain(`data-ratio="${defaultCoverRatio}"`);
    expect(hero).toContain('data-size="fill"');
    expect(html).toContain(member.subject.cover!.media);
    expect(hero).not.toContain(member.subject.cover!.media);
    if (cover) {
      expect(hero).toContain('data-collection-cover-source="owner"');
      expect(hero).toContain(`src="${coverSrc(cover.media, 'webp', 320)}"`);
      expect(hero).toContain('alt=""');
      expect(hero).not.toContain('data-slot="cover-placeholder-title"');
    } else {
      expect(hero).toContain('data-collection-cover-source="none"');
      expect(hero).toContain('data-state="placeholder"');
      expect(hero).toContain('data-slot="cover-placeholder-title"');
      expect(hero).toContain(page.title);
      expect(hero).toContain(placeholderColors({ id: page.id }).background);
      expect(hero).toContain('aria-hidden="true"');
      expect(hero).not.toContain('<img');
      expect(hero).not.toContain(ownCover.media);
    }
  }
});

test('compact presentation preserves genuine member preparation, unavailable feedback and retry without exposing stale members', async () => {
  for (const memberState of ['preparing', 'unavailable'] as const) {
    const html = await render({ ...page, memberState, publicExport: false, viewerActions: { state: 'unavailable' } });
    expect(html).toContain(
      memberState === 'preparing' ? m.library_dynamic_preparing() : m.library_dynamic_unavailable(),
    );
    expect(html).toContain(m.library_collection_reload());
    expect(html).toContain(m.library_collection_actions_unavailable());
    expect(html).not.toContain(m.library_collection_kind_pending());
    expect(html).not.toContain(m.library_collection_empty());
    expect(html).not.toContain('data-slot="member-list-row-title"');
    expect(html).not.toContain(m.library_collection_export_label());
  }
});

test('existing Collection pages render supplied Book author and publication year with type labels in every launch locale', async () => {
  const previousLocale = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const html = await render({
        ...page,
        listPresentations: {
          'schema:Book': parseListPresentation(definitions.release.types['schema:Book'].listPresentation)!,
        },
        members: collectionStoryMembers.map((member) => ({
          ...member,
          subject: {
            ...subjectOf(member.subject)!,
            typeLabel: pickText(definitions.release.types['schema:Book'].labels, locale).text,
          },
        })),
      });
      expect(html.match(/data-slot="member-list-row-title"/g)).toHaveLength(4);
      const facts = [...html.matchAll(/<p\b[^>]*data-slot="member-list-row-facts"[^>]*>([\s\S]*?)<\/p>/g)].map(
        (match) => match[1]!,
      );
      expect(facts).toHaveLength(4);
      for (const [index, author, year] of [
        [0, locale === 'ja' ? '川端康成' : 'Yasunari Kawabata', 1937],
        [1, locale === 'ja' ? '紫式部' : 'Murasaki Shikibu', undefined],
        [2, pickText(subjectRecording.related['01a17a3b-07ab-779f-a76f-c4de973680d4'].labels, locale).text, 1943],
        [3, locale === 'ja' ? '夏目漱石' : 'Natsume Sōseki', 1914],
      ] as const) {
        expect(facts[index]!).toContain(author);
        if (year !== undefined)
          expect(facts[index]!).toContain(new Intl.NumberFormat(locale, { useGrouping: false }).format(year));
      }
      expect(html).toContain('data-slot="collection-hero"');
      expect(html).toContain('data-slot="collection-toolbar"');
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});
