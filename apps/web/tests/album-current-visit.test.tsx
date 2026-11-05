import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import {
  albumCurrentVisitReturnHref,
  createAlbumCurrentVisitLink,
  type AlbumCurrentVisitOrigin,
} from '../src/features/catalogue/album-current-visit-model';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { candidateContext } from '../src/subject/candidates';

mock.module('cloudflare:workers', () => ({ env: {} }));

async function installDom(url: string) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url });
  const globals: Record<string, unknown> = { window, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'document navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLFormElement Element Node MutationObserver ResizeObserver Document DocumentFragment'.split(
    ' ',
  ))
    globals[key] = Reflect.get(window, key);
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  globals.scrollTo = () => {};
  globals.scrollBy = () => {};
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    window,
    restore: async () => {
      await window.happyDOM.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const origin: AlbumCurrentVisitOrigin = {
  version: 1,
  subject: { id: '00000000-0000-4000-8000-00000000a101', type: 'schema:MusicAlbum', label: 'Harbour sessions' },
  address: '/en/subjects/00000000-0000-4000-8000-00000000a101/harbour-sessions#connections',
  locale: 'en',
  context: { id: candidateContext, population: 'global', label: 'Global' },
  release: 'release-1',
  reader: 'reader-1',
};
const validateAddress = (value: unknown, locale: string) => subjectVisitReturn(value, locale);
const albumId = origin.subject.id;

test('the public Album entry waits for a deliberate Global choice before reading distinct current evidence', async () => {
  const { window, restore } = await installDom('https://site.test/visit');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { AlbumCurrentVisitGate } = await import('../src/features/catalogue/album-current-visit');
  const { AlbumProfile } = await import('../src/features/catalogue/album-profile-view');
  const { AlbumProfileEntry } = await import('../src/features/catalogue/album-profile-entry');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { albumFixture } = await import('../src/kernel/fake/catalogue-album-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = albumFixture();
  const date = fixture.publicRead.subject.statements['schema:datePublished']![0]!;
  const duplicate = structuredClone(date);
  duplicate.id = crypto.randomUUID();
  duplicate.references[0]!.parts[0]!.value.content = 'https://duplicate.example/evidence';
  fixture.publicRead.subject.statements['schema:datePublished']!.push(duplicate);
  let profileLoads = 0;
  let evidenceReads = 0;
  const available = {
    state: 'available' as const,
    actions: [
      { action: 'statement:propose', operations: ['subject.propose', 'subject.list_candidates'] },
      { action: 'subject:read', operations: ['subject.list_candidates'] },
    ],
  };
  const readEvidence = async () => {
    evidenceReads += 1;
    const result = await fixture.editors.facts.read();
    return result.ok ? { ...result, actions: { subject: available, context: available } } : result;
  };
  const editors = { ...fixture.editors, facts: { ...fixture.editors.facts, read: readEvidence } };
  const transport = {
    ...fixture.transport,
    load: async () => {
      profileLoads += 1;
      const correction = await readEvidence();
      return correction.ok
        ? { ok: true as const, release: correction.release, public: correction.public, correction }
        : correction;
    },
  };
  const entry = createAlbumCurrentVisitLink(
    `/en/subjects/${albumId}/harbour-sessions/album`,
    origin,
    'en',
    validateAddress,
  );
  function Surface() {
    return (
      <CandidateReaderBoundary
        observed={{ state: 'signed-in', subject: 'reader-1', csrfToken: 'fixture' }}
        address={albumId}
      >
        <AlbumProfileEntry id={albumId} label={origin.subject.label} locale="en" visit={entry.token} />
        <AlbumCurrentVisitGate
          id={albumId}
          slug="harbour-sessions"
          locale="en"
          origin={origin}
          token={entry.token}
          renderCorrection={() => (
            <AlbumProfile
              id={albumId}
              locale="en"
              session="signed-in"
              transport={transport}
              search={async () => []}
              editors={editors}
            />
          )}
        />
      </CandidateReaderBoundary>
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const visitRoute = createRoute({ getParentRoute: () => rootRoute, path: '/visit', component: Surface });
  const router = createRouter({
    routeTree: rootRoute.addChildren([visitRoute]),
    history: createMemoryHistory({ initialEntries: ['/visit'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  try {
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await settle();
    const canvas = within(host);
    const entryLink = canvas.getByRole('link', { name: m.album_edit({}, { locale: 'en' }) });
    expect(new URL((entryLink as HTMLAnchorElement).href).searchParams.get('visit')).toBe(entry.token);
    expect(profileLoads).toBe(0);
    expect(evidenceReads).toBe(0);
    await act(async () =>
      user.click(canvas.getByRole('button', { name: m.album_current_global_choice({}, { locale: 'en' }) })),
    );
    await canvas.findByRole('region', { name: m.album_identity({}, { locale: 'en' }) });
    expect(profileLoads).toBe(1);
    expect(evidenceReads).toBe(1);
    expect(canvas.getByText('https://duplicate.example/evidence')).toBeTruthy();
    expect(canvas.getAllByText(m.facts_selected_value({ number: 1 }, { locale: 'en' })).length).toBeGreaterThan(0);
    expect(canvas.getAllByText(m.facts_selected_value({ number: 2 }, { locale: 'en' })).length).toBeGreaterThan(0);
    expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false);
    const returnLink = canvas.getByRole('link', { name: m.album_current_return_original({}, { locale: 'en' }) });
    expect((returnLink as HTMLAnchorElement).href).toContain('#album-current-return=');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await restore();
  }
});

test('public return waits for fresh admission and cancels focus when the person interacts', async () => {
  const entry = createAlbumCurrentVisitLink(
    `/en/subjects/${albumId}/harbour-sessions/album`,
    origin,
    'en',
    validateAddress,
  );
  const returnHref = albumCurrentVisitReturnHref(origin, entry.token)!;
  const { window, restore } = await installDom(`https://site.test${returnHref}`);
  let queued: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    queued = callback;
    return 1;
  };
  const { createRoot } = await import('react-dom/client');
  const { AlbumCurrentVisitReturn } = await import('../src/features/catalogue/album-current-visit');
  const { m } = await import('../src/paraglide/messages.js');
  const current = {
    subjectId: albumId,
    locale: 'en',
    context: origin.context,
    release: origin.release,
    reader: origin.reader,
    address: origin.address,
  };
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const sentinel = window.document.createElement('button');
  sentinel.textContent = 'Keep current focus';
  window.document.body.append(sentinel);
  sentinel.focus();
  let root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <>
          <AlbumCurrentVisitReturn locale="en" current={current} validateAddress={validateAddress} />
          <h1 tabIndex={-1}>Current Album reading</h1>
        </>,
      ),
    );
    await act(async () => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      queued?.(0);
    });
    expect(window.location.hash).toContain('#album-current-return=');
    expect(window.document.activeElement).toBe(sentinel);
    await act(async () => root.unmount());
    root = createRoot(host);
    window.history.replaceState({}, '', returnHref);
    queued = undefined;
    await act(async () =>
      root.render(
        <>
          <AlbumCurrentVisitReturn locale="en" current={current} validateAddress={validateAddress} />
          <h1 tabIndex={-1}>Current Album reading</h1>
        </>,
      ),
    );
    await act(async () => queued?.(0));
    expect(window.location.hash).toBe('#connections');
    expect(window.document.activeElement?.textContent).toBe('Current Album reading');
    expect(host.textContent).not.toContain(m.album_current_return_changed({}, { locale: 'en' }));
  } finally {
    await act(async () => root.unmount());
    sentinel.remove();
    await restore();
  }
});
