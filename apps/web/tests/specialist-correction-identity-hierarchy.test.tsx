import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';

// UNRUN: actual renderers and supplied request fixtures. This does not establish native disclosure,
// browser geometry, SSR or growth acceptance; the long production stories carry browser oracles.
test('Specialist corrections lead with human identity and retain exact optional references without acquiring editors', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
  const { LiteraryProfile } = await import('../src/features/catalogue/literary-profile-view');
  const { AlbumProfile } = await import('../src/features/catalogue/album-profile-view');
  const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
  const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
  const { gameProfileFixture, gameId } = await import('../src/kernel/fake/catalogue-game-profile');
  const { literaryFixture, literaryWorkId } = await import('../src/kernel/fake/catalogue-literary-profile');
  const { albumFixture, albumId } = await import('../src/kernel/fake/catalogue-album-profile');
  const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { pickText } = await import('@rezics/composition');
  const { definitionGuideHref } = await import('../src/features/catalogue/definition-guide');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = async (node: ReactNode) => {
    await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
    // Let existing query notifications settle; this is not another read or a timer-based assertion.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const reset = async () => {
    await render(null);
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  };
  try {
    for (const locale of ['en', 'de'] as const) {
      overwriteGetLocale(() => locale);
      const o = { locale };
      for (const kind of ['game', 'literary', 'album', 'manga'] as const) {
        await reset();
        // CSS is not laid out by this renderer. Both widths and RTL retain complete strings and wrapping hooks.
        host.style.width = locale === 'en' ? '1280px' : '390px';
        host.dir = locale === 'en' ? 'ltr' : 'rtl';
        const title = 'A complete human subject name — ' + 'UnbrokenHumanName'.repeat(24);
        const description = 'A complete supplied description. '.repeat(12);
        const alias = 'An alias kept in full ' + 'UnbrokenAlias'.repeat(24);
        const typeName = 'A complete localized kind ' + 'UnbrokenKind'.repeat(24);
        const terms = {
          labels: { [locale]: title, ar: 'اسم أصلي كامل' },
          descriptions: { [locale]: description, fr: 'Une description sans nom dans cette langue.' },
          aliases: { [locale]: [alias], ja: ['名前のない言語の別名'] },
        };
        const game = gameProfileFixture('ready', locale, true);
        const literary = literaryFixture('ready', locale, 'schema:Book', true);
        const album = albumFixture('ready', locale);
        const manga = mangaFixture('ready', locale);
        const literaryRead = await literary.transport.load();
        if (!literaryRead.ok || !literaryRead.current) throw new Error('Expected admitted literary fixture');
        Object.assign(game.publicRead.subject, terms);
        Object.assign(literaryRead.current.public.subject, terms);
        Object.assign(album.publicRead.subject, terms);
        Object.assign(manga.reads.get(mangaVolumeId)!.subject, terms);
        const types = {
          game: 'schema:VideoGame',
          literary: 'schema:Book',
          album: 'schema:MusicAlbum',
          manga: 'schema:PublicationVolume',
        };
        const id = { game: gameId, literary: literaryWorkId, album: albumId, manga: mangaVolumeId }[kind];
        const type = types[kind];
        game.release.types['schema:VideoGame']!.labels = { [locale]: typeName };
        literaryRead.release = structuredClone(literaryRead.release);
        literaryRead.release.types['schema:Book']!.labels = { [locale]: typeName };
        album.release.types['schema:MusicAlbum']!.labels = { [locale]: typeName };
        manga.release.types['schema:PublicationVolume']!.labels = { [locale]: typeName };
        let refusal = false;
        let uncertain = false;
        let relationMounts = 0;
        function RelationProbe() {
          relationMounts++;
          return <p data-probe="relations">Supplied relation editor</p>;
        }
        const search = async () => [];
        const failure = { ok: false as const, reason: 'denied' as const };
        const node = (session: 'signed-in' | 'signed-out' = 'signed-in') => {
          if (kind === 'game')
            return (
              <GameProfile
                id={id}
                locale={locale}
                session={session}
                search={search}
                onNavigate={() => {}}
                transport={{ ...game.transport, load: async () => (refusal ? failure : game.transport.load()) }}
              />
            );
          if (kind === 'literary')
            return (
              <LiteraryProfile
                id={id}
                locale={locale}
                session={session}
                transport={{ ...literary.transport, load: async () => (refusal ? failure : literaryRead) }}
                facts={{
                  ...literary.facts,
                  propose: async (command) =>
                    uncertain ? { ok: false, reason: 'uncertain' } : literary.facts.propose(command),
                }}
                review={literary.review}
                relations={<RelationProbe />}
              />
            );
          if (kind === 'album')
            return (
              <AlbumProfile
                id={id}
                locale={locale}
                session={session}
                search={search}
                transport={{ ...album.transport, load: async () => (refusal ? failure : album.loadCorrection()) }}
                editors={album.editors}
              />
            );
          return (
            <MangaProfileEditor
              id={id}
              locale={locale}
              session={session}
              search={search}
              transport={{
                ...manga.transport,
                load: async () => (refusal ? failure : readMangaProfile(manga.client, id)),
              }}
              correction={{
                facts: { read: async () => failure, propose: manga.propose },
                review: literary.review,
                relations: <RelationProbe />,
                authored: null,
              }}
            />
          );
        };
        await render(node());
        await waitFor(() => canvas.getByRole('heading', { level: 2, name: title }));
        const heading = canvas.getByRole('heading', { level: 2, name: title });
        const reference = canvas.getByText(m.specialist_identity_reference({}, o), { selector: 'summary' });
        const details = reference.closest('details')!;
        expect(host.querySelector('h1')!.compareDocumentPosition(heading) & 4).toBeTruthy();
        expect(heading.compareDocumentPosition(reference) & 4).toBeTruthy();
        expect(heading.closest('details')).toBeNull();
        expect(details.open).toBe(false);
        const code = [...details.querySelectorAll('code')];
        expect(code.map((node) => node.textContent)).toEqual([id, type]);
        expect(details.textContent).toContain(m.specialist_identity_subject_id({}, o));
        expect(details.textContent).toContain(m.specialist_identity_type({}, o));
        for (const node of code) {
          expect(node.dir).toBe('ltr');
          expect(node.className).toContain('select-text');
          expect(node.className).toContain('[overflow-wrap:anywhere]');
        }
        expect(canvas.getByText(typeName).closest('details')).toBeNull();
        const warnings = {
          game: m.game_profile_grain({}, o),
          literary: m.literary_grain({}, o),
          album: m.album_grain({}, o),
          manga: m.manga_intro({}, o),
        };
        expect(canvas.getByText(warnings[kind]).closest('details')).toBeNull();
        expect(canvas.getByText(m.specialist_identity_scope({}, o)).closest('details')).toBeNull();
        const href = subjectHref({ id, label: title }, locale).href;
        expect(canvas.getAllByRole('link', { name: m.candidate_view_public({}, o) })).toHaveLength(1);
        expect(canvas.getByRole('link', { name: m.candidate_view_public({}, o) }).getAttribute('href')).toBe(href);
        expect(
          [...host.querySelectorAll('a')].filter((link) => link.getAttribute('href') === `${href}/terms`),
        ).toHaveLength(1);
        if (kind !== 'literary') {
          const guide = definitionGuideHref(locale, {
            type,
            ...(kind === 'manga' ? {} : { returnTo: `${href}/${kind}` }),
          });
          expect([...host.querySelectorAll('a')].some((link) => link.getAttribute('href') === guide)).toBe(true);
        } else
          expect(canvas.getByRole('link', { name: m.changes_title({}, o) }).getAttribute('href')).toBe(
            `${href}/changes`,
          );
        const calls = () => JSON.stringify([game.calls, literary.calls, album.calls, manga.calls]);
        const before = calls();
        const mountsBefore = relationMounts;
        // Native summary is a single, enabled keyboard stop, with no custom role or event adapter.
        expect(reference.tagName).toBe('SUMMARY');
        expect(reference.getAttribute('role')).toBeNull();
        expect(reference.getAttribute('tabindex')).not.toBe('-1');
        reference.focus();
        expect(window.document.activeElement).toBe(reference);
        await act(async () => {
          await user.tab();
          await user.tab({ shift: true });
        });
        expect(window.document.activeElement).toBe(reference);
        for (let i = 0; i < 3; i++) {
          await act(async () => {
            await user.click(reference);
          });
          expect(details.open).toBe(true);
          await act(async () => {
            await user.click(reference);
          });
          expect(details.open).toBe(false);
        }
        const names = canvas.getByText(m.specialist_identity_names({}, o), { selector: 'summary' });
        await act(async () => {
          await user.click(names);
        });
        expect(host.textContent).toContain(description);
        expect(host.textContent).toContain(alias);
        expect(host.textContent).toContain('Une description sans nom dans cette langue.');
        expect(host.textContent).toContain('名前のない言語の別名');
        for (const text of [title, description, alias, typeName]) {
          const node = [...host.querySelectorAll('h2, p, dd')].find((element) => element.textContent === text)!;
          expect(node).toBeDefined();
          expect(node.className).toContain('[overflow-wrap:anywhere]');
          expect(node.closest('[class*="truncate"], [class*="line-clamp"], [class*="overflow-hidden"]')).toBeNull();
        }
        expect(calls()).toBe(before);
        expect(relationMounts).toBe(mountsBefore);
        if (kind === 'literary') {
          expect(relationMounts).toBe(0);
          const relations = canvas.getByText(m.literary_relations({}, o), { selector: 'summary' });
          await act(async () => {
            await user.click(relations);
          });
          await waitFor(() => expect(relationMounts).toBe(1));
          await act(async () => {
            await user.click(relations);
            await user.click(relations);
          });
          expect(relationMounts).toBe(1);
        }
        expect(
          [game.calls, literary.calls, album.calls, manga.calls].flat().some((call) => call.method === 'POST'),
        ).toBe(false);
        // An uncertain correction stays in its opened editor, outside the optional identity disclosures.
        uncertain = true;
        game.setScenario('uncertain');
        album.setScenario('uncertain');
        manga.setScenario('uncertain');
        const property = {
          game: 'schema:gamePlatform',
          literary: 'schema:wordCount',
          album: 'schema:datePublished',
          manga: 'schema:numberOfPages',
        }[kind];
        const release = {
          game: game.release,
          literary: literaryRead.release,
          album: album.release,
          manga: manga.release,
        }[kind];
        let editor = canvas;
        if (kind === 'game') {
          const summary = canvas.getByText(m.game_profile_classification({}, o), { selector: 'summary' });
          await act(async () => {
            await user.click(summary);
          });
          editor = within(summary.closest('details')!);
        }
        const fieldLabel = pickText(release.properties[property]!.labels, locale).text;
        const field = within(
          kind === 'game'
            ? editor.getByRole('heading', { name: fieldLabel }).closest('section')!
            : editor.getByRole('region', { name: fieldLabel }),
        );
        await act(async () => {
          await user.click(field.getByRole('button', { name: m.facts_edit_field({}, o) }));
        });
        const inputName =
          kind === 'game'
            ? m.correction_value({}, o)
            : kind === 'album'
              ? m.correction_year({}, o)
              : m.correction_amount({}, o);
        const input = field.getByRole('textbox', { name: inputName });
        const changedValue = { game: 'fr', literary: '+13000', album: '2025', manga: '+196' }[kind];
        await act(async () => {
          await user.clear(input);
          await user.type(input, changedValue);
        });
        await act(async () => {
          await user.click(editor.getByRole('button', { name: m.facts_submit({}, o) }));
        });
        // Classification retains its existing generic failure message for a lost response.
        const uncertainMessage = kind === 'game' ? m.correction_unavailable({}, o) : m.facts_uncertain({}, o);
        await waitFor(() => field.getByText(uncertainMessage));
        const uncertainty = field.getByText(uncertainMessage);
        expect(details.contains(uncertainty)).toBe(false);
        if (uncertainty.closest('details')) expect(uncertainty.closest('details')!.open).toBe(true);
        expect(input.value).toBe(changedValue);
        expect(details.open).toBe(false);
        expect(canvas.queryByText(m.correction_proposed({}, o))).toBeNull();
        const writesBeforeSignOut = [game.calls, literary.calls, album.calls, manga.calls]
          .flat()
          .filter((call) => call.method === 'POST').length;
        // Missing names retain the existing honest fallback; no ID is repurposed as a human heading.
        for (const subject of [
          game.publicRead.subject,
          literaryRead.current.public.subject,
          album.publicRead.subject,
          manga.reads.get(mangaVolumeId)!.subject,
        ])
          subject.labels = {};
        await reset();
        await render(node('signed-out'));
        await waitFor(() => canvas.getByRole('heading', { level: 2, name: m.subject_value_unlabelled({}, o) }));
        expect(host.querySelector('h2')!.textContent).not.toContain(id);
        expect(host.querySelector('h2')!.textContent).not.toContain(type);
        expect(
          [game.calls, literary.calls, album.calls, manga.calls].flat().filter((call) => call.method === 'POST'),
        ).toHaveLength(writesBeforeSignOut);
        // A fresh refused read has none of the fixture's undisclosed identity, even inside closed details or attributes.
        refusal = true;
        await reset();
        await render(node());
        await waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
        expect(host.innerHTML).not.toContain(title);
        expect(host.innerHTML).not.toContain(description);
        expect(host.innerHTML).not.toContain(alias);
        expect(host.innerHTML).not.toContain(id);
        expect(canvas.queryByText(m.specialist_identity_reference({}, o))).toBeNull();
      }
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    overwriteGetLocale(previousLocale);
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
