import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import type { BookStructure, PublicationReview, StudioPort, StudioRevision } from '../src/studio/contract';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { fromPlainText } = await import('@rezics/document');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { StudioController } = await import('../src/studio/controller');
const { StudioPublication } = await import('../src/studio/publication');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, locales } = await import('../src/paraglide/runtime.js');
afterAll(async () => {
  setLocale('en', { reload: false });
  await dom.restore();
});

test('release messages have the same keys and complete named arguments in all eight locales', async () => {
  const catalogues = await Promise.all(
    locales.map((locale) => Bun.file(`${import.meta.dir}/../messages/${locale}.json`).json()),
  );
  const keys = Object.keys(catalogues[0])
    .filter((key) => key.startsWith('studio_release_'))
    .sort();
  expect(keys.length).toBe(34);
  const args = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const catalogue of catalogues) {
    expect(Object.keys(catalogue).sort()).toEqual(Object.keys(catalogues[0]).sort());
    for (const key of keys) {
      expect(catalogue[key].trim().length).toBeGreaterThan(0);
      expect(args(catalogue[key])).toEqual(args(catalogues[0][key]));
    }
  }
});

test.each(['book', 'articles'] as const)(
  'German %s review keeps exact values through accessible confirmation and receipt',
  async (kind) => {
    setLocale('de', { reload: false });
    const options = { locale: 'de' as const };
    const title = '原稿 <A & "B">';
    const body = fromPlainText('Private <body> & 本文', 'blocks');
    const exact = { postId: 'private-post', revisionId: 'pinned-revision', sha256: await editionDocumentDigest(body) };
    const revision: StudioRevision = { exact, title, body, mediaIds: [], savedAt: '2026-11-13T12:34:56.123456Z' };
    const structure: BookStructure = {
      catalogueId: 'private-book',
      revision: 'exact-outline',
      canOrganize: false,
      limits: { maxDepth: 4, maxPlacements: 20 },
      placements: [
        { occurrenceId: 'part', parentOccurrenceId: null, title: 'Part <一>', target: { kind: 'part' } },
        { occurrenceId: 'chapter', parentOccurrenceId: 'part', title, target: { kind: 'chapter', document: exact } },
        {
          occurrenceId: 'unselected',
          parentOccurrenceId: null,
          title: 'Outside this release',
          target: { kind: 'chapter', document: exact },
        },
      ],
    };
    const expiresAt = '2099-11-13T12:34:56.123456Z';
    const publishedAt = '2026-11-13T12:34:56.654321Z';
    const unused = mock(async (): Promise<never> => {
      throw new Error('Release review must not edit or load drafts.');
    });
    const port: StudioPort = {
      isCurrent: () => true,
      documents: unused,
      open: unused,
      createDraft: unused,
      saveDraft: unused,
      versions: unused,
      revision: unused,
      publications: unused,
      reviewPublication: mock(async ({ target }) => {
        const review: PublicationReview = {
          reviewId: kind === 'book' ? 'exact-review' : '',
          authority: kind === 'book' ? 'hosted' : 'local',
          target,
          expectedPublicationRevision: null,
          expiresAt,
          bookOutline: kind === 'book' ? { ...structure, placements: structure.placements.slice(0, 2) } : null,
          entries: [{ occurrenceId: kind === 'book' ? 'chapter' : null, title, document: exact }],
          notices: ['Supplied <notice> & Hinweis'],
          ...(kind === 'articles'
            ? { articleSnapshot: { boardId: 'exact-board', licence: 'CC BY 4.0', subjectIds: [], mediaIds: [], body } }
            : {}),
        };
        return { ok: true, value: review };
      }),
      publish: mock(async ({ review }) => ({
        ok: true,
        value: {
          publicationId: 'release',
          revision: 'exact-release',
          publishedAt,
          state: 'published',
          entries: review.entries,
          ...(kind === 'articles'
            ? { readbackSelection: { revision, visibility: 'published', permissions: { edit: true, publish: true } } }
            : {}),
        },
      })),
    };
    const controller = new StudioController(
      {
        visitKey: 'release-language',
        projectId: 'private-project',
        title: 'Studio',
        profile: kind === 'book' ? { kind, structure } : { kind, seriesTitle: null },
        initialSelection: { revision, permissions: { edit: true, publish: true } },
        documents: { items: [], nextCursor: null },
        publications: { items: [], nextCursor: null },
        canCreateDraft: false,
        canPublish: true,
      },
      port,
    );
    const disconnect = controller.connect();
    if (kind === 'book') controller.toggleOccurrence('chapter', true);
    const reviews = spyOn(controller, 'reviewPublication');
    const publishes = spyOn(controller, 'publish');
    function View() {
      const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
      return <StudioPublication controller={controller} state={state} />;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const button = (name: string) => getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement;
    try {
      await act(async () => root.render(<View />));
      expect(getByRole(host, 'region', { name: 'Veröffentlichung' })).toBeTruthy();
      expect(host.textContent).toContain(m.studio_release_history_empty({}, options));
      await act(async () => {
        button('Veröffentlichung prüfen…').click();
        await reviews.mock.results.at(-1)?.value;
      });
      expect(getByRole(host, 'heading', { name: 'Diesen Stand prüfen' })).toBeTruthy();
      expect(host.textContent).toContain(m.studio_release_first({}, options));
      expect(host.textContent).toContain(title);
      expect(host.textContent).toContain('Supplied <notice> & Hinweis');
      expect([...host.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(Object.values(exact));
      if (kind === 'book') {
        const outline = getByRole(host, 'navigation', {
          name: 'Eingefrorenes Inhaltsverzeichnis der Veröffentlichung',
        });
        expect(outline.textContent).toBe(`Part <一>${title}`);
        expect(host.textContent).not.toContain('Outside this release');
        expect(host.textContent).toContain('1 Kapitel ausgewählt');
        expect(host.textContent).toContain('Strukturrevision: exact-outline');
        expect(host.querySelector('time')?.getAttribute('datetime')).toBe(expiresAt);
        expect(host.querySelector('time')?.textContent).toBe(`Die Prüfung läuft am ${expiresAt} ab.`);
      } else {
        const details = getByRole(host, 'region', { name: 'Details zur bestätigten Artikelrevision' });
        expect(details.textContent).toContain('exact-board');
        expect(details.textContent).toContain('CC BY 4.0');
        expect(details.textContent).toContain('Private <body> & 本文');
        expect(details.textContent).toContain(m.own_drafts_no_references({}, options));
        expect(host.querySelector('time')).toBeNull();
      }
      const publishName = kind === 'book' ? 'Geprüfte Kapitel veröffentlichen' : 'Geprüften Artikel veröffentlichen';
      expect(button(publishName).disabled).toBe(true);
      expect(port.publish).not.toHaveBeenCalled();
      await act(async () =>
        getByRole(host, 'checkbox', {
          name:
            kind === 'book'
              ? 'Ich habe diese exakten Versionen geprüft und möchte diesen Stand veröffentlichen.'
              : m.studio_account_confirm({}, options),
          exact: true,
        }).click(),
      );
      expect(button(publishName).disabled).toBe(false);
      const reviewed = controller.snapshot().review;
      await act(async () => {
        button(publishName).click();
        await publishes.mock.results.at(-1)?.value;
      });
      expect(port.publish).toHaveBeenCalledTimes(1);
      expect(port.publish).toHaveBeenCalledWith(
        { projectId: 'private-project', review: reviewed, idempotencyKey: expect.any(String) },
        expect.any(AbortSignal),
      );
      expect(getByRole(host, 'status').textContent).toBe(
        'Stand exact-release veröffentlicht. Spätere Entwurfsänderungen ändern diese Veröffentlichung nicht.',
      );
      expect(queryByRole(host, 'checkbox')).toBeNull();
      expect(host.textContent).toContain('Veröffentlichungsverlauf');
      expect(host.textContent).toContain('Enthaltene Versionen');
      expect(host.textContent).toContain(kind === 'book' ? '1 Kapitel' : '1 Artikel');
      expect(host.textContent).toContain('Revision: exact-release');
      expect(host.querySelector('time')?.getAttribute('datetime')).toBe(publishedAt);
      expect(host.querySelector('time')?.textContent).toBe(publishedAt);
      expect(unused).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      disconnect();
      host.remove();
      reviews.mockRestore();
      publishes.mockRestore();
    }
  },
);
