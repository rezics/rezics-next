import { expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient, type SubjectRead } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ui } from './game-reader-view.test';
import { gameExample } from '../src/features/catalogue/game-reader/examples';
import type { GameReaderRead, GameReaderTransport } from '../src/features/catalogue/game-reader/model';
import {
  readAlbumEditions,
  type AlbumEditionRead,
  type AlbumEditionAddress,
} from '../src/features/catalogue/music-reader';
import { albumFixture } from '../src/kernel/fake/catalogue-album-profile';
import { readingOverviewExample } from '../src/kernel/fake/reading-overview';
import { defaultReader, type Reader } from '../src/subject/reader';
import { m } from '../src/paraglide/messages.js';

let gameTransport: GameReaderTransport;
let editionTransport: (address: AlbumEditionAddress) => Promise<AlbumEditionRead>;
const profile = mock(() => {
  throw new Error('Overview must not reread the album profile');
});
const editions = mock(({ data }: { data: AlbumEditionAddress }) => editionTransport(data));
mock.module('../src/features/catalogue/album-profile-actions', () => ({
  loadAlbumProfile: profile,
  loadAlbumEditions: editions,
}));
mock.module('../src/features/catalogue/game-reader/actions', () => ({
  loadGameReader: ({ data }: { data: Parameters<GameReaderTransport>[0] }) => gameTransport(data),
}));
mock.module('../src/features/catalogue/album-track-reader/actions', () => ({
  loadAlbumTracks: async () => ({ ok: false, reason: 'unavailable' }),
}));
const { SubjectPage, pageContext } = await import('../src/features/pages/subject');
const { subjectPageMessages, viewTabLabels } = await import('../src/features/pages/route-support');
type Page = Parameters<typeof SubjectPage>[0]['page'];
const settle = (action: () => void) =>
  act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function pageFor(publicRead: SubjectRead, release: Release, links?: ReturnType<typeof gameExample>['first']): Page {
  const page = readingOverviewExample('game').page;
  page.subject = publicRead.subject.id;
  page.context = { id: publicRead.subject.context, population: { kind: 'global' } };
  page.catalogue = {
    state: 'released',
    type: publicRead.subject.type,
    digest: publicRead.subject.release,
    definitions: release,
  };
  delete page.community;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') page.reads[key] = { status: 200, body: publicRead };
    if (links && read.kind === 'links' && read.property === 'schema:exampleOfWork')
      page.reads[key] = { status: 200, body: links };
  }
  return page;
}

async function mount(page: Page, reader?: Reader) {
  const mounted = await ui();
  type Input = { page: Page; reader?: Reader | undefined };
  let update!: (input: Input) => void;
  function Visit() {
    const [input, setInput] = useState<Input>({ page, reader });
    update = setInput;
    return (
      <SubjectPage
        page={input.page}
        {...(input.reader ? { reader: input.reader } : {})}
        locale="en"
        messages={subjectPageMessages()}
        tabLabels={viewTabLabels()}
        renderJsonLd={false}
      />
    );
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Visit }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  await mounted.renderContent(<RouterProvider router={router} />);
  return {
    ...mounted,
    render: (nextReader?: Reader, nextPage = page) => settle(() => update({ page: nextPage, reader: nextReader })),
  };
}

test.each([undefined, defaultReader])(
  'Subject Game caller preserves first prepared zero/nonzero, selection, disclosure and pending work from %j',
  async (sentinel) => {
    for (const spoilerLevel of [0, 2] as const)
      for (const pending of [false, true]) {
        const fixture = gameExample();
        const page = pageFor(fixture.publicRead, fixture.release, fixture.first);
        const flight = Promise.withResolvers<GameReaderRead>();
        let requests = 0;
        gameTransport = () => {
          requests++;
          return flight.promise;
        };
        const mounted = await mount(page, sentinel);
        try {
          const fact = mounted.host.querySelector('[data-game-current-assertion]');
          expect(fact).not.toBeNull();
          const disclosure = await mounted.disclose(m.subject_editions());
          if (pending) await mounted.click(m.work_parts_more());
          else await mounted.click(m.game_reader_inspect());
          const selected = mounted.host.querySelector('[data-slot="game-edition-inspection"]');
          if (!pending) expect(selected).not.toBeNull();
          const prepared: Reader = { spoilerLevel, suitability: 'blur' };
          await mounted.render(prepared);
          await mounted.render({ ...prepared });
          expect(mounted.host.querySelector('[data-game-current-assertion]')).toBe(fact);
          expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBe(selected);
          expect(disclosure.isConnected && disclosure.open).toBe(true);
          expect(requests).toBe(pending ? 1 : 0);
          if (pending) {
            const reply = await fixture.read({ ...fixture.address, cursor: fixture.first.next! });
            await act(async () => flight.resolve(reply));
            expect(disclosure.textContent).toContain(m.game_reader_editions_empty());
          }
          await mounted.render({ ...prepared, spoilerLevel: spoilerLevel === 0 ? 2 : 0 });
          expect(mounted.host.querySelector('[data-game-current-assertion]')).toBeNull();
          await mounted.render(prepared);
          expect(mounted.host.textContent).toContain(m.game_reader_retired());
          await mounted.render(prepared, { ...page });
          expect(mounted.host.querySelector('[data-game-current-assertion]')).not.toBeNull();
          expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBeNull();
        } finally {
          await mounted.close();
        }
      }
  },
);

test('Subject Album shows page facts before native Editions, retries its exact address and distinguishes failed/empty/unsupported/bounded rows', async () => {
  const fixture = albumFixture();
  const page = pageFor(fixture.publicRead, fixture.release);
  const flight = Promise.withResolvers<Response>();
  const calls: URL[] = [];
  let reply: Response | undefined;
  const client = createKernelClient('https://album.example', {
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url);
        return url.pathname.endsWith('/links') ? (reply?.clone() ?? flight.promise) : Response.json(fixture.publicRead);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const definitions = { ...fixture.release, digest: fixture.publicRead.subject.release };
  editionTransport = (address) => readAlbumEditions(client, definitions, address, 'en');
  editions.mockClear();
  profile.mockClear();
  const mounted = await mount(page);
  try {
    const album = () => mounted.host.querySelector('[data-slot="music-album-reader"]')!;
    const window = () => album().querySelector('[data-slot="music-album-editions"]')!;
    expect(album().querySelector('[data-slot="profile-group-credits"]')?.textContent).toContain('The Harbour Ensemble');
    expect(window().textContent).toContain(m.candidate_loading());
    expect(window().textContent).not.toContain(m.music_reader_empty());
    expect(profile).toHaveBeenCalledTimes(0);
    await settle(() => flight.resolve(Response.json({}, { status: 503 })));
    expect(window().textContent).toContain(m.album_tracks_unavailable());
    expect(album().textContent).toContain('The Harbour Ensemble');
    reply = Response.json({ links: [], next: null, freshness: { caught_up: true } });
    const retry = window().querySelector<HTMLButtonElement>('button')!;
    await settle(() => {
      retry.click();
      retry.click();
    });
    expect(window().textContent).toContain(m.music_context_empty_page());
    expect(editions.mock.calls.map(([call]) => call.data)).toEqual(
      Array(2).fill({ id: fixture.publicRead.subject.id, context: fixture.publicRead.subject.context }),
    );
    expect(calls.filter((url) => url.pathname.endsWith('/links')).map((url) => url.search)).toEqual(
      Array(2).fill(calls[1]!.search),
    );
    expect(calls[1]!.searchParams.get('limit')).toBe('20');
    expect(calls[1]!.searchParams.get('cursor')).toBeNull();
    const row = gameExample().first.links[0]!;
    row.property = row.assertion!.property.id = 'schema:releaseOf';
    row.assertion!.value.content = fixture.publicRead.subject.id;
    row.type = row.summary!.type = 'schema:MusicRelease';
    row.summary!.types = ['schema:MusicRelease'];
    row.label = row.summary!.label!.value = 'Japan CD';
    reply = Response.json({ links: [row], next: 'opaque:album/?+曲', freshness: { caught_up: false } });
    await mounted.render(undefined, { ...page });
    expect(window().querySelector('a')?.textContent).toBe('Japan CD');
    expect(album().textContent).toContain(m.profile_reader_page_incomplete({ label: 'schema:releaseOf' }));
    expect(calls.filter((url) => url.pathname.endsWith('/links'))).toHaveLength(3);
    const unsupported = structuredClone(fixture.release);
    delete unsupported.properties['schema:releaseOf'];
    unsupported.properties['schema:contributor']!.labels.en = 'Replacement credit label';
    editionTransport = (address) => readAlbumEditions(client, { ...definitions, ...unsupported }, address, 'en');
    await mounted.render(undefined, { ...page, catalogue: { ...page.catalogue!, definitions: unsupported } });
    expect(window().textContent).toContain(m.album_tracks_unconfigured());
    expect(window().textContent).not.toContain(m.music_context_empty_page());
    expect(album().textContent).toContain('The Harbour Ensemble');
    expect(album().textContent).toContain('Replacement credit label');
    expect(profile).toHaveBeenCalledTimes(0);
  } finally {
    await mounted.close();
  }
});

test.each(['source', 'viewer', 'locale', 'context', 'definitions', 'withdrawal'] as const)(
  'Album %s replacement fences pending Editions and stale facts',
  async (replacement) => {
    const fixture = albumFixture();
    const flight = Promise.withResolvers<AlbumEditionRead>();
    editionTransport = () => flight.promise;
    const { MusicAlbumOverview } = await import('../src/features/catalogue/music-reader-view');
    const mounted = await ui();
    const source = {};
    const props = {
      source,
      locale: 'en',
      public: fixture.publicRead,
      release: fixture.release,
      reader: null as string | null,
    };
    try {
      await mounted.renderContent(<MusicAlbumOverview {...props} />);
      expect(mounted.host.textContent).toContain('The Harbour Ensemble');
      const next = {
        ...props,
        ...(replacement === 'source'
          ? { source: {} }
          : replacement === 'viewer'
            ? { reader: 'other' }
            : replacement === 'locale'
              ? { locale: 'ja' }
              : replacement === 'context'
                ? {
                    public: {
                      ...fixture.publicRead,
                      subject: { ...fixture.publicRead.subject, context: '00000000-0000-4000-8000-000000000099' },
                    },
                  }
                : { release: structuredClone(fixture.release) }),
      };
      if (replacement === 'source')
        editionTransport = async () => ({ ok: true, admitted: true, rows: [], next: null, caughtUp: true });
      await mounted.renderContent(replacement === 'withdrawal' ? null : <MusicAlbumOverview {...next} />);
      await settle(() => flight.resolve({ ok: false, reason: 'withheld' }));
      expect(mounted.host.textContent).not.toContain(m.music_reader_denied());
      if (replacement === 'source') expect(mounted.host.textContent).toContain(m.music_context_empty_page());
      else if (replacement === 'withdrawal') expect(mounted.host.textContent).toBe('');
      else {
        expect(mounted.host.querySelector('[data-slot="music-album-reader"]')).toBeNull();
        await mounted.renderContent(<MusicAlbumOverview {...props} />);
        expect(mounted.host.textContent).toContain(m.music_reader_stale());
      }
    } finally {
      await mounted.close();
    }
  },
);
