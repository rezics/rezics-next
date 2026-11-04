import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { CreateResult, CreatedReader, InitialSubject } from '../src/features/catalogue/create-subject';
import * as start from '../.storybook/react-start';
import { allowedCreateAuthority, type CreateAuthority } from '../src/features/catalogue/identity-intake';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const sessionModule = await import('../src/session/query');

function withPlaceGrain(source: Release): Release {
  const release = structuredClone(source);
  release.types['schema:Place'] = {
    iri: 'http://schema.org/Place',
    labels: { en: 'place' },
    descriptions: { en: 'A location used as music-context identity.' },
    mappings: [],
    bases: ['schema:Thing'],
    properties: ['schema:name', 'schema:sameAs', 'schema:url'].filter((id) => !!release.properties[id]),
    facets: [],
  };
  return release;
}

const release = withPlaceGrain(bundledRelease);
const digest = 'sha256:music-context-create-eligibility';
type Viewer = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject: string | null;
  csrfToken: string | null;
};
const signedIn: Viewer = { state: 'signed-in', subject: 'alice', csrfToken: 'csrf-alice' };
let viewer: Viewer = signedIn;
let observe: () => Promise<CreateAuthority> = async () => allowedCreateAuthority;
const commands: { item: InitialSubject; key: string }[] = [];
let submitImpl: (command: { item: InitialSubject; key: string }) => Promise<CreateResult> = async () => ({
  ok: false,
  reason: 'unavailable',
});
let readImpl: (id: string) => Promise<CreatedReader> = async () => ({ state: 'unavailable' });

mock.module('../src/session/query', () => ({ ...sessionModule, useSession: () => viewer }));
mock.module('../src/features/catalogue/create-subject-actions', () => ({
  readCatalogueCreateEligibility: () => observe(),
  readCreatedCatalogueSubject: async ({ data }: { data: string }) => readImpl(data),
}));
mock.module('../src/features/catalogue/music-context-create-actions', () => ({
  loadMusicContextCreate: async () => ({ ok: true as const, digest, release }),
  createCatalogueMusicContext: async ({ data }: { data: { item: InitialSubject; key: string } }) => {
    commands.push({ item: data.item, key: data.key });
    const result = await submitImpl(data);
    if (!result.ok) return result;
    const { musicContextCreateAdmitReader } = await import('../src/features/catalogue/music-context-create');
    return {
      ...result,
      reader: musicContextCreateAdmitReader(result.reader, result.id, release, data.item.type),
    };
  },
}));
mock.module('../src/features/catalogue/relation-editor-search', () => ({ relationTargetSearch: async () => [] }));

test('music-context creation exposes only real released grains and emitted fields', async () => {
  const { musicContextCreateDraft, musicContextCreateFields, musicContextCreateTypes } =
    await import('../src/features/catalogue/music-context-create');
  const { musicContextKind } = await import('../src/features/catalogue/music-context-profile');
  expect(musicContextCreateTypes(bundledRelease, 'en')).toEqual([]);
  const offered = musicContextCreateTypes(release, 'en');
  const typeId = offered.some((entry) => entry.id === 'schema:Place') ? 'schema:Place' : offered[0]!.id;
  expect(offered.map(({ id }) => id).sort()).toEqual(
    Object.keys(release.types)
      .filter((id) => musicContextKind(release, id) !== 'unsupported')
      .sort(),
  );
  for (const type of offered) {
    expect(type.bases).toEqual(release.types[type.id]!.bases);
    expect(
      musicContextCreateFields(release, type.id).every((id) => release.types[type.id]!.properties.includes(id)),
    ).toBe(true);
  }
  const unsupported = musicContextCreateDraft(release, { type: 'schema:Book', labels: { en: 'Not a place' } }, []);
  expect(unsupported.errors.some((error) => error.pointer === '/type' && error.code === 'unsupported')).toBe(true);
  const extra = musicContextCreateDraft(release, { type: typeId, labels: { en: 'Hall' } }, [
    {
      key: 'blocked',
      statement: {
        property: { id: 'rezics:not-admitted-field' },
        value: { type: 'value', content: 'no' },
        references: [],
        rank: 'normal',
      },
    },
  ]);
  expect(
    extra.errors.some(
      (error) => error.pointer === '/statements/rezics:not-admitted-field' && error.code === 'unsupported',
    ),
  ).toBe(true);
});

test('generic creation links to the localized music-context visit', async () => {
  const { catalogueEntries } = await import('../src/features/catalogue/catalogue-entry');
  expect(catalogueEntries.musicContextCreate({ locale: 'fr' })).toMatchObject({
    group: 'create',
    href: '/fr/catalogue/music-context',
  });
});

async function musicContextSession(locale = 'en') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/${locale}/catalogue/music-context` });
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
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { MusicContextCreateSession } = await import('../src/features/catalogue/music-context-create-session');
  const { musicContextCreateFields, musicContextCreateTypes } =
    await import('../src/features/catalogue/music-context-create');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['session'], viewer);
  window.location.assign = () => undefined;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });
  const types = musicContextCreateTypes(release, locale);
  const typeId = types.some((entry) => entry.id === 'schema:Place') ? 'schema:Place' : types[0]!.id;
  function Harness() {
    return createElement(QueryClientProvider, {
      client,
      children: createElement(MusicContextCreateSession, {
        locale,
        initial: { ok: true, digest, release },
      }),
    });
  }
  await act(async () => root.render(createElement(Harness)));
  return {
    window,
    host,
    canvas,
    user,
    waitFor,
    client,
    m,
    typeId,
    typeMeaning: types.find((entry) => entry.id === typeId),
    urlFact: musicContextCreateFields(release, typeId).find((id) => id === 'schema:sameAs' || id === 'schema:url'),
    async refresh() {
      client.setQueryData(['session'], viewer);
      await act(async () => root.render(createElement(Harness)));
    },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

async function chooseTypeAndName(page: Awaited<ReturnType<typeof musicContextSession>>, type: string, label: string) {
  await act(async () =>
    page.user.selectOptions(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() }), type),
  );
  await act(async () =>
    page.user.type(page.canvas.getByRole('textbox', { name: page.m.catalogue_create_language() }), 'en'),
  );
  await act(async () =>
    page.user.type(page.canvas.getByRole('textbox', { name: page.m.catalogue_create_label() }), label),
  );
}

test('the mounted music-context visit keeps descriptors when eligibility is refused, unknown, or guest', async () => {
  commands.length = 0;
  viewer = signedIn;
  observe = async () => ({ state: 'refused', reason: 'permission' });
  const page = await musicContextSession();
  try {
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    await chooseTypeAndName(page, page.typeId, 'Kept draft');
    expect(
      (page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(commands).toHaveLength(0);

    observe = async () => ({ state: 'unknown', reason: 'unavailable' });
    await act(async () =>
      page.user.click(page.canvas.getByRole('button', { name: page.m.identity_intake_authority_retry() })),
    );
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(page.m.identity_intake_authority_unknown()),
    );
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    expect(
      (page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);

    viewer = { state: 'signed-out', subject: null, csrfToken: null };
    await page.refresh();
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_guest()));
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    expect(
      (page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('an admitted music-context Type creates once after a current eligibility review', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c401';
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  commands.length = 0;
  submitImpl = async (command) => ({
    ok: true,
    id: createdId,
    reader: {
      state: 'ready',
      href: `/en/subjects/${createdId}/reviewed-place`,
      identity: { id: createdId, type: command.item.type, label: command.item.labels.en ?? '' },
    },
  });
  const page = await musicContextSession();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, page.typeId, 'Reviewed place');
    if (page.typeMeaning?.description) expect(page.host.textContent).toContain(page.typeMeaning.description);
    const dirty = new page.window.Event('beforeunload', { cancelable: true });
    page.window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    if (page.urlFact) {
      await act(async () =>
        page.user.selectOptions(
          page.canvas.getByRole('combobox', { name: page.m.music_context_create_add_fact() }),
          page.urlFact!,
        ),
      );
      const button = page.canvas
        .getAllByRole('button', { name: page.m.correction_add() })
        .find((node) => !(node as HTMLButtonElement).disabled);
      await act(async () => page.user.click(button!));
      const row = page.host.querySelector('[data-slot="music-context-initial-fact"]') as HTMLElement;
      await act(async () =>
        page.user.type(row.querySelector('input, textarea') as HTMLElement, 'https://example.org/place'),
      );
    }
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() => expect(page.host.querySelector('[data-music-context-create-review]')).not.toBeNull());
    observe = async () => ({ state: 'refused', reason: 'permission' });
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(commands).toHaveLength(0);
    observe = async () => allowedCreateAuthority;
    await act(async () =>
      page.user.click(page.canvas.getByRole('button', { name: page.m.identity_intake_authority_retry() })),
    );
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() })).toBeDefined(),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.item.type).toBe(page.typeId);
    expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() }).getAttribute('href')).toBe(
      `/en/subjects/${createdId}/reviewed-place`,
    );
  } finally {
    await page.close();
  }
});

test('viewer replacement drops a late allowed observation; uncertain retry keeps the exact command', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c411';
  viewer = signedIn;
  commands.length = 0;
  let pending: ((value: CreateAuthority) => void) | undefined;
  let calls = 0;
  observe = () => {
    calls += 1;
    if (calls === 1) return new Promise<CreateAuthority>((resolve) => (pending = resolve));
    return Promise.resolve({ state: 'refused', reason: 'permission' });
  };
  const page = await musicContextSession();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_reading()));
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    viewer = { state: 'signed-in', subject: 'bob', csrfToken: 'csrf-bob' };
    await page.refresh();
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    pending?.(allowedCreateAuthority);
    await act(async () => undefined);
    expect(page.canvas.getByRole('alert').textContent).toContain(page.m.identity_intake_authority_refused_permission());
    expect(
      (page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(commands).toHaveLength(0);
  } finally {
    await page.close();
  }

  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  commands.length = 0;
  let lost = true;
  let reads = 0;
  submitImpl = async () => {
    if (lost) {
      lost = false;
      throw new TypeError('Response lost');
    }
    return { ok: true, id: createdId, reader: { state: 'unavailable' } };
  };
  readImpl = async (id) => {
    reads += 1;
    expect(id).toBe(createdId);
    return {
      state: 'ready',
      href: `/en/subjects/${createdId}/recovered`,
      identity: { id: createdId, type: 'schema:Place', label: 'Recovered place' },
    };
  };
  const retryPage = await musicContextSession();
  try {
    await retryPage.waitFor(() =>
      expect(retryPage.host.textContent).toContain(retryPage.m.identity_intake_authority_allowed()),
    );
    await chooseTypeAndName(retryPage, retryPage.typeId, 'Uncertain place');
    await act(async () =>
      retryPage.user.click(retryPage.canvas.getByRole('button', { name: retryPage.m.catalogue_create_submit() })),
    );
    await retryPage.waitFor(() =>
      expect(retryPage.host.querySelector('[data-music-context-create-review]')).not.toBeNull(),
    );
    await act(async () =>
      retryPage.user.click(retryPage.canvas.getByRole('button', { name: retryPage.m.catalogue_create_submit() })),
    );
    await retryPage.waitFor(() =>
      expect(retryPage.canvas.getByRole('button', { name: retryPage.m.catalogue_create_retry() })).toBeDefined(),
    );
    observe = async () => ({ state: 'refused', reason: 'permission' });
    await act(async () =>
      retryPage.user.click(retryPage.canvas.getByRole('button', { name: retryPage.m.catalogue_create_retry() })),
    );
    await retryPage.waitFor(() => expect(retryPage.host.textContent).toContain(createdId));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.key).toBe(commands[0]!.key);
    expect(commands[1]!.item).toEqual(commands[0]!.item);
    expect(commands[0]!.item.type).toBe(retryPage.typeId);
    await act(async () =>
      retryPage.user.click(retryPage.canvas.getByRole('button', { name: retryPage.m.catalogue_create_retry() })),
    );
    await retryPage.waitFor(() =>
      expect(retryPage.canvas.getByRole('link', { name: retryPage.m.catalogue_create_open() })).toBeDefined(),
    );
    expect(reads).toBe(1);
    expect(commands).toHaveLength(2);
  } finally {
    await retryPage.close();
  }
});
