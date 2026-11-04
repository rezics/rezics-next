import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, useMemo, useRef, useState } from 'react';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Release } from '@rezics/definitions';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import {
  musicContextCreateControl,
  musicContextCreateDraft,
  musicContextCreateFields,
  musicContextCreateHolders,
  musicContextCreatePreparedFacts,
  musicContextCreateTypes,
} from '../src/features/catalogue/music-context-create';
import { musicContextKind } from '../src/features/catalogue/music-context-profile';
import { allowedCreateAuthority, type CreateAuthority } from '../src/features/catalogue/identity-intake';
import type { CreateResult, CreatedReader, InitialSubject } from '../src/features/catalogue/create-subject';
import type { StatementInput } from '../src/features/catalogue/statement-editor';

mock.module('cloudflare:workers', () => ({ env: {} }));

const release = bundledRelease;
const offered = musicContextCreateTypes(release, 'en');
const typeId = offered.some((entry) => entry.id === 'schema:Place') ? 'schema:Place' : offered[0]!.id;
const typeMeaning = offered.find((entry) => entry.id === typeId);
const urlFact = musicContextCreateFields(release, typeId).find((id) => id === 'schema:sameAs' || id === 'schema:url');
type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
let session: Session = 'signed-in';
let observe: () => Promise<CreateAuthority> = async () => allowedCreateAuthority;
const commands: { item: InitialSubject; key: string }[] = [];
let submitImpl: (command: { item: InitialSubject; key: string }) => Promise<CreateResult> = async () => ({
  ok: false,
  reason: 'unavailable',
});
let readImpl: (id: string) => Promise<CreatedReader> = async () => ({ state: 'unavailable' });

test('music-context creation exposes only real released grains and emitted fields', () => {
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

test('generic creation links to the localized music-context visit', () => {
  expect(catalogueEntries.musicContextCreate({ locale: 'fr' })).toMatchObject({
    group: 'create',
    href: '/fr/catalogue/music-context',
  });
});

async function musicContextVisit(locale = 'en') {
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
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { MusicContextCreateFields } = await import('../src/features/catalogue/music-context-create-fields');
  const { MusicContextCreateReview } = await import('../src/features/catalogue/music-context-create-review');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });
  const factsId = 'music-context-initial-facts';
  type Fact = { key: string; statement: StatementInput };
  function Harness({ currentLocale, currentSession }: { currentLocale: string; currentSession: Session }) {
    const [factsByType, setFactsByType] = useState<Record<string, Fact[]>>({});
    const prepared = useRef<{
      release: Release;
      holders: ReturnType<typeof musicContextCreateHolders>;
    }>();
    const types = musicContextCreateTypes(release, currentLocale);
    const profile = useMemo(
      () => ({
        title: m.music_context_create_title({}, { locale: currentLocale as never }),
        intro: m.music_context_create_intro({}, { locale: currentLocale as never }),
        href: `/${currentLocale}/catalogue/music-context`,
        scope: 'music-context-create',
        metadata: { ready: true, pending: false, failure: null, types },
        retainTypeDrafts: true,
        initialLanguage: '',
        canEditType: (type: string) =>
          types.some((entry) => entry.id === type) && musicContextKind(release, type) !== 'unsupported',
        canCreateType: (type: string) => types.some((entry) => entry.id === type),
        fields: (type: string, disabled: boolean, canEdit: () => boolean, invalidate?: () => void) =>
          h(MusicContextCreateFields, {
            type,
            release,
            locale: currentLocale,
            search: async () => [],
            facts: factsByType[type] ?? [],
            disabled,
            canEdit,
            invalidate: invalidate ?? (() => undefined),
            discardTypeDraft: () => undefined,
            change: (next: Fact[]) =>
              setFactsByType((current) => {
                const copy = { ...current };
                if (next.length) copy[type] = next;
                else delete copy[type];
                return copy;
              }),
          }),
        prepare: (initial: InitialSubject) => {
          const facts = musicContextCreatePreparedFacts(factsByType[initial.type] ?? [], release);
          const result = musicContextCreateDraft(release, initial, facts);
          prepared.current = { release, holders: musicContextCreateHolders(facts) };
          return result;
        },
        control: (pointer: string, type: string) => {
          const snapshot = prepared.current;
          if (!snapshot) return undefined;
          return musicContextCreateControl(
            pointer,
            snapshot.holders,
            factsByType[type] ?? [],
            type,
            snapshot.release,
            currentLocale,
            factsId,
          );
        },
        review: (state: { item: InitialSubject; stale: boolean }) => {
          const snapshot = prepared.current;
          if (!snapshot) return null;
          return h(MusicContextCreateReview, {
            item: state.item as InitialSubject & { statements: Record<string, StatementInput[]> },
            holders: snapshot.holders,
            release: snapshot.release,
            locale: currentLocale,
            stale: state.stale,
            factsId,
            onJump: (id: string) => host.querySelector<HTMLElement>(`[id="${id}"]`)?.focus(),
          });
        },
      }),
      [currentLocale, factsByType, types],
    );
    return h(QueryClientProvider, {
      client,
      children: h(CreateSubjectForm, {
        locale: currentLocale,
        session: currentSession,
        transport: {
          eligibility: () => observe(),
          submit: async (command: { item: InitialSubject; key: string }) => {
            commands.push(command);
            return submitImpl(command);
          },
          read: (id: string) => readImpl(id),
        },
        onNavigate: () => undefined,
        profile,
      }),
    });
  }
  await act(async () => root.render(h(Harness, { currentLocale: locale, currentSession: session })));
  return {
    host,
    canvas,
    user,
    waitFor,
    m,
    window,
    async refresh(nextLocale = locale) {
      await act(async () => root.render(h(Harness, { currentLocale: nextLocale, currentSession: session })));
    },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

async function chooseTypeAndName(page: Awaited<ReturnType<typeof musicContextVisit>>, label: string) {
  await act(async () =>
    page.user.selectOptions(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() }), typeId),
  );
  await act(async () =>
    page.user.type(page.canvas.getByRole('textbox', { name: page.m.catalogue_create_language() }), 'en'),
  );
  await act(async () =>
    page.user.type(page.canvas.getByRole('textbox', { name: page.m.catalogue_create_label() }), label),
  );
}

test('the mounted music-context visit keeps admitted Types when eligibility is refused, unknown, or guest', async () => {
  commands.length = 0;
  session = 'signed-in';
  observe = async () => ({ state: 'refused', reason: 'permission' });
  const page = await musicContextVisit();
  try {
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    await chooseTypeAndName(page, 'Kept draft');
    if (typeMeaning?.description) expect(page.host.textContent).toContain(typeMeaning.description);
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

    session = 'signed-out';
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

test('an admitted Type is reviewed, repaired, created once and opened at the exact returned identity', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c401';
  session = 'signed-in';
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
  const page = await musicContextVisit();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, 'Reviewed place');
    if (typeMeaning?.description) expect(page.host.textContent).toContain(typeMeaning.description);
    const dirty = new page.window.Event('beforeunload', { cancelable: true });
    page.window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    if (urlFact) {
      const add = page.canvas.getByRole('combobox', { name: page.m.music_context_create_add_fact() });
      await act(async () => page.user.selectOptions(add, urlFact));
      const button = page.canvas
        .getAllByRole('button', { name: page.m.music_context_create_add_fact() })
        .find((node) => !(node as HTMLButtonElement).disabled);
      await act(async () => page.user.click(button!));
      const row = page.host.querySelector('[data-slot="music-context-initial-fact"]') as HTMLElement;
      const value = row.querySelector('input, textarea') as HTMLElement;
      await act(async () => page.user.type(value, 'https://example.org/place'));
    }
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() => expect(page.host.querySelector('[data-music-context-create-review]')).not.toBeNull());
    await act(async () =>
      page.user.click(page.canvas.getAllByRole('button', { name: page.m.music_context_create_review_open() })[0]!),
    );
    await act(async () =>
      page.user.type(page.canvas.getByRole('textbox', { name: page.m.catalogue_create_label() }), ' hall'),
    );
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() => expect(page.host.querySelector('[data-music-context-create-review]')).not.toBeNull());
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() })).toBeDefined(),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.item.type).toBe(typeId);
    expect(commands[0]!.item.labels.en).toBe('Reviewed place hall');
    if (urlFact) expect(commands[0]!.item.statements?.[urlFact]?.[0]?.rank).toBe('normal');
    expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() }).getAttribute('href')).toBe(
      `/en/subjects/${createdId}/reviewed-place`,
    );
  } finally {
    await page.close();
  }
});

test('revoking create grant after an allowed read cannot prepare a fresh music-context create', async () => {
  session = 'signed-in';
  observe = async () => allowedCreateAuthority;
  commands.length = 0;
  const page = await musicContextVisit();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, 'Stale grant place');
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() => expect(page.host.querySelector('[data-music-context-create-review]')).not.toBeNull());
    observe = async () => ({ state: 'refused', reason: 'permission' });
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(
      (page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('locale replacement drops a late allowed observation; uncertain retry keeps the exact command', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c411';
  session = 'signed-in';
  commands.length = 0;
  let pending: ((value: CreateAuthority) => void) | undefined;
  let calls = 0;
  observe = () => {
    calls += 1;
    if (calls === 1) return new Promise<CreateAuthority>((resolve) => (pending = resolve));
    return Promise.resolve({ state: 'refused', reason: 'permission' });
  };
  const page = await musicContextVisit();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_reading()));
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    await page.refresh('fr');
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission({}, { locale: 'fr' }),
      ),
    );
    pending?.(allowedCreateAuthority);
    await act(async () => undefined);
    expect(page.canvas.getByRole('alert').textContent).toContain(
      page.m.identity_intake_authority_refused_permission({}, { locale: 'fr' }),
    );
    expect(
      (page.canvas.getByRole('button', {
        name: page.m.catalogue_create_submit({}, { locale: 'fr' }),
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(commands).toHaveLength(0);
  } finally {
    await page.close();
  }

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
      identity: { id: createdId, type: typeId, label: 'Recovered place' },
    };
  };
  const retryPage = await musicContextVisit();
  try {
    await retryPage.waitFor(() =>
      expect(retryPage.host.textContent).toContain(retryPage.m.identity_intake_authority_allowed()),
    );
    await chooseTypeAndName(retryPage, 'Uncertain place');
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
    expect(commands[0]!.item.type).toBe(typeId);
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
