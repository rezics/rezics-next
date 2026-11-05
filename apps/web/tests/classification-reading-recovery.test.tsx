import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, useState, type ReactNode } from 'react';
import type { FactCommand, FactsCurrent } from '../src/features/catalogue/subject-facts';
import type { MangaCorrectionPorts } from '../src/features/catalogue/manga-profile-corrections';
import type { EditorRead } from '../src/features/catalogue/statement-editor';

mock.module('cloudflare:workers', () => ({ env: {} }));

const concept = '00000000-0000-4000-8000-00000000d301';
const citation = 'https://archive.example/classification/' + 'private-source-'.repeat(8);

async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    click: (node: HTMLElement, detail?: number) => Promise<void>;
    enter: (input: HTMLInputElement, value: string) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLFormElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'DocumentFragment',
    'Document',
    'ShadowRoot',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === 'window'
          ? window
          : key === 'IS_REACT_ACT_ENVIRONMENT'
            ? true
            : ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
              ? window[key].bind(window)
              : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  try {
    await run({
      host,
      render: (node) => act(async () => root.render(h(QueryClientProvider, { client }, node))),
      click: (node, detail = 1) =>
        act(async () => {
          node.focus();
          node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));
        }),
      enter: async (input, value) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
      },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function button(scope: ParentNode, name: string) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
  expect(found).toBeDefined();
  return found!;
}

function attachGenre(
  read: { public: { subject: { statements: Record<string, unknown[]> }; related: Record<string, unknown> } },
  source: { id: string },
) {
  const seed = structuredClone(source) as Record<string, unknown>;
  read.public.subject.statements['schema:genre'] = [
    {
      ...seed,
      id: '00000000-0000-4000-8000-00000000d201',
      property: { id: 'schema:genre', data_type: 'wikibase-item' },
      value: { type: 'value', content: concept },
      qualifiers: [],
      references: [
        {
          hash: 'genre-evidence',
          parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: citation } }],
        },
      ],
    },
  ];
  read.public.related[concept] = { type: 'skos:Concept', labels: { en: 'Private genre concept' } };
}

function withdrawClassifications(read: { release: { types: Record<string, { properties: string[] } | undefined> } }) {
  for (const type of Object.values(read.release.types)) {
    if (type) type.properties = type.properties.filter((id) => id !== 'schema:genre' && id !== 'schema:keywords');
  }
}

test('Album and Manga keep one classification holder across reading loss, withdrawal and keyboard recovery', async () => {
  await mounted(async ({ host, render, click, enter }) => {
    const { MangaCorrections } = await import('../src/features/catalogue/manga-profile-corrections');
    const { catalogueEditor } = await import('../src/features/catalogue/editor-lifetime');
    const { AlbumProfile } = await import('../src/features/catalogue/album-profile-view');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
    const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
    const { albumFixture, albumId } = await import('../src/kernel/fake/catalogue-album-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const manga = mangaFixture();
    const mangaRead = await readMangaProfile(manga.client, mangaVolumeId);
    if (!mangaRead.ok || !mangaRead.public) throw new Error('Expected Manga');
    attachGenre(mangaRead, mangaRead.public.subject.statements['wdt:P179']![0]!);
    const album = albumFixture();
    attachGenre({ public: album.publicRead }, album.publicRead.subject.statements['schema:contributor']![0]!);
    const albumInitial = await album.loadCorrection();
    if (!albumInitial.ok || !albumInitial.public) throw new Error('Expected Album');
    const commands: FactCommand[] = [];
    let finish!: (result: Awaited<ReturnType<typeof manga.propose>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof manga.propose>>>((resolve) => {
      finish = resolve;
    });
    const ports: MangaCorrectionPorts = {
      facts: {
        read: async () => {
          throw new Error('Unexpected Manga fact read');
        },
        propose: (command) => {
          commands.push(command);
          return pending;
        },
      },
      review: () => ({
        reader: 'fixture',
        read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
        confirm: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      }),
      relations: null,
      authored: null,
    };
    const MangaHolder = catalogueEditor(function MangaHolderLive({ children }: { children: ReactNode; id?: string }) {
      return children;
    });
    function MangaHost({ ready, reading }: { ready: boolean; reading: typeof mangaRead }) {
      return (
        <MangaHolder id={mangaVolumeId}>
          <MangaCorrections
            read={ready ? reading : undefined}
            locale="en"
            disabled={false}
            ports={ports}
            reload={async () => {}}
            search={async () => []}
          />
        </MangaHolder>
      );
    }
    let showManga!: (ready: boolean, reading?: typeof mangaRead) => void;
    function MangaPage() {
      const [ready, setReady] = useState(true);
      const [reading, setReading] = useState(mangaRead);
      showManga = (next, nextRead) => {
        if (nextRead) setReading(nextRead);
        setReady(next);
      };
      return <MangaHost ready={ready} reading={reading} />;
    }
    await render(<MangaPage />);
    const genre = () =>
      [...host.querySelectorAll('h3')].find((node) => node.textContent === 'genre')?.closest('section');
    expect(genre()).toBeDefined();
    await click(button(genre()!, m.facts_edit_field()));
    const url = () => genre()!.querySelector<HTMLInputElement>('input[type="url"]')!;
    await enter(url(), citation + 'manga');
    await click(button(genre()!, m.correction_submit()));
    expect(commands).toHaveLength(1);
    const sealed = commands[0]!;
    await act(async () => showManga(false));
    expect(host.querySelector('header, input, select, [role="combobox"]')).toBeNull();
    expect(host.textContent).not.toContain(m.facts_edit_field());
    expect(host.innerHTML).not.toContain('The Paper Observatory');
    await act(async () => showManga(true));
    expect(url().value).toBe(citation + 'manga');
    expect(host.textContent).toContain(m.classification_recovery_summary());
    await click(button(genre()!, m.correction_retry()));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(sealed);
    expect(commands[1]).toEqual(sealed);
    const withdrawn = structuredClone(mangaRead);
    withdrawClassifications(withdrawn);
    await act(async () => showManga(true, withdrawn));
    expect(host.textContent).toContain(m.classification_recovery_withdrawn());
    expect(host.textContent).toContain(m.facts_private());
    expect(genre()?.textContent).toContain(citation + 'manga');
    expect(button(genre()!, m.correction_retry()).disabled).toBe(false);
    expect(genre()?.querySelector('[role="combobox"]')).toBeNull();
    await act(async () => finish({ ok: false, reason: 'denied' }));

    let nextRead: EditorRead | Promise<EditorRead> = await album.editors.facts.read();
    const albumEditors = {
      ...album.editors,
      facts: {
        ...album.editors.facts,
        read: async () => nextRead,
        propose: async (command: FactCommand) => {
          commands.push(command);
          return { ok: false as const, reason: 'uncertain' as const };
        },
      },
    };
    await render(
      <CandidateReaderBoundary
        observed={{ state: 'signed-in', subject: 'viewer', csrfToken: 'album-session' }}
        address={albumId}
      >
        <AlbumProfile
          id={albumId}
          locale="en"
          session="signed-in"
          transport={{ ...album.transport, load: async () => albumInitial }}
          search={async () => []}
          editors={albumEditors}
        />
      </CandidateReaderBoundary>,
    );
    const albumGenre = () =>
      [...host.querySelectorAll('h3')].find((node) => node.textContent === 'genre')?.closest('section');
    for (let attempt = 0; attempt < 50 && !albumGenre(); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(albumGenre()).toBeDefined();
    await click(button(albumGenre()!, m.facts_edit_field()));
    const albumUrl = () => albumGenre()!.querySelector<HTMLInputElement>('input[type="url"]')!;
    await enter(albumUrl(), citation + 'album');
    let resolveRead!: (read: EditorRead) => void;
    nextRead = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const reload = button(host, m.correction_reload());
    await click(reload, 0);
    expect(host.querySelector('[role="combobox"], input[type="url"]')).toBeNull();
    expect(host.textContent).not.toContain(m.facts_edit_field());
    const recovered = (await album.editors.facts.read()) as FactsCurrent;
    await act(async () => resolveRead(recovered));
    for (let attempt = 0; attempt < 50 && !albumUrl(); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(albumUrl().value).toBe(citation + 'album');
    expect(host.textContent).toContain(m.classification_recovery_summary());
    expect(host.ownerDocument.activeElement?.textContent).toContain(m.classification_recovery_summary());
    const albumWithdrawn = structuredClone(recovered);
    withdrawClassifications(albumWithdrawn);
    nextRead = albumWithdrawn;
    await click(button(host, m.correction_reload()), 1);
    for (let attempt = 0; attempt < 50 && !host.textContent?.includes(m.classification_recovery_withdrawn()); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(host.textContent).toContain(m.classification_recovery_withdrawn());
    expect(albumGenre()?.querySelector('[role="combobox"]')).toBeNull();
    expect(button(albumGenre()!, m.correction_submit()).disabled).toBe(true);
  });
});
