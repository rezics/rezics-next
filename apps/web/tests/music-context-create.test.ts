import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { bundledRelease } from '@rezics/definitions/bundled';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import {
  musicContextCreateDraft,
  musicContextCreateFields,
  musicContextCreateTypes,
} from '../src/features/catalogue/music-context-create';
import { musicContextKind } from '../src/features/catalogue/music-context-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

const release = bundledRelease;
const offered = musicContextCreateTypes(release, 'en');
const typeId = offered.some((entry) => entry.id === 'schema:Place') ? 'schema:Place' : offered[0]!.id;

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

test('a contributor creates an admitted music-context identity with current eligibility', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/music-context' });
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
  const { act, createElement as h, useMemo, useRef, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { allowedCreateAuthority } = await import('../src/features/catalogue/identity-intake');
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { MusicContextCreateFields } = await import('../src/features/catalogue/music-context-create-fields');
  const { MusicContextCreateReview } = await import('../src/features/catalogue/music-context-create-review');
  const {
    musicContextCreateControl,
    musicContextCreateHolders,
    musicContextCreatePreparedFacts,
  } = await import('../src/features/catalogue/music-context-create');
  const { m } = await import('../src/paraglide/messages.js');
  type Authority = typeof allowedCreateAuthority | { state: 'guest' | 'refused' | 'unknown'; reason?: string };
  type Command = { item: { type: string; labels: Record<string, string>; statements?: Record<string, { rank?: string }[]> }; key: string };
  const commands: Command[] = [];
  let observe: () => Promise<Authority> = async () => allowedCreateAuthority;
  const createdId = '00000000-0000-4000-8000-00000000c401';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });
  const factsId = 'music-context-initial-facts';
  const typeMeaning = offered.find((entry) => entry.id === typeId);
  const urlFact = musicContextCreateFields(release, typeId).find((id) => id === 'schema:sameAs' || id === 'schema:url');
  function Harness({ locale, session }: { locale: string; session: 'signed-in' | 'signed-out' }) {
    const [factsByType, setFactsByType] = useState<Record<string, { key: string; statement: never }[]>>({});
    const prepared = useRef<{ release: typeof release; holders: ReturnType<typeof musicContextCreateHolders> }>();
    const types = musicContextCreateTypes(release, locale);
    const profile = useMemo(
      () => ({
        title: m.music_context_create_title({}, { locale: locale as never }),
        intro: m.music_context_create_intro({}, { locale: locale as never }),
        href: `/${locale}/catalogue/music-context`,
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
            locale,
            search: async () => [],
            facts: factsByType[type] ?? [],
            disabled,
            canEdit,
            invalidate: invalidate ?? (() => undefined),
            discardTypeDraft: () => undefined,
            change: (next: { key: string; statement: never }[]) =>
              setFactsByType((current) => {
                const copy = { ...current };
                if (next.length) copy[type] = next;
                else delete copy[type];
                return copy;
              }),
          }),
        prepare: (initial: { type: string; labels: Record<string, string> }) => {
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
            locale,
            factsId,
          );
        },
        review: (state: { item: { type: string; labels: Record<string, string>; statements?: Record<string, never[]> }; stale: boolean }) => {
          const snapshot = prepared.current;
          if (!snapshot) return null;
          return h(MusicContextCreateReview, {
            item: state.item,
            holders: snapshot.holders,
            release: snapshot.release,
            locale,
            stale: state.stale,
            factsId,
            onJump: (id: string) => host.querySelector<HTMLElement>(`[id="${id}"]`)?.focus(),
          });
        },
      }),
      [factsByType, locale, types],
    );
    return h(QueryClientProvider, {
      client,
      children: h(CreateSubjectForm, {
        locale,
        session,
        transport: {
          eligibility: () => observe(),
          submit: async (command: Command) => {
            commands.push(command);
            return {
              ok: true,
              id: createdId,
              reader: {
                state: 'ready',
                href: `/en/subjects/${createdId}/reviewed-place`,
                identity: { id: createdId, type: command.item.type, label: command.item.labels.en ?? '' },
              },
            };
          },
          read: async () => ({ state: 'unavailable' }),
        },
        onNavigate: () => undefined,
        profile,
      }),
    });
  }
  try {
    observe = async () => ({ state: 'refused', reason: 'permission' });
    await act(async () => root.render(h(Harness, { locale: 'en', session: 'signed-in' })));
    await waitFor(() =>
      expect(canvas.getByRole('alert').textContent).toContain(m.identity_intake_authority_refused_permission()),
    );
    expect(canvas.getByRole('combobox', { name: m.catalogue_create_type() })).toBeDefined();
    observe = async () => ({ state: 'unknown', reason: 'unavailable' });
    await act(async () => user.click(canvas.getByRole('button', { name: m.identity_intake_authority_retry() })));
    await waitFor(() =>
      expect(canvas.getByRole('alert').textContent).toContain(m.identity_intake_authority_unknown()),
    );
    await act(async () => root.render(h(Harness, { locale: 'en', session: 'signed-out' })));
    await waitFor(() => expect(host.textContent).toContain(m.identity_intake_authority_guest()));
    expect((canvas.getByRole('button', { name: m.catalogue_create_submit() }) as HTMLButtonElement).disabled).toBe(true);
    expect(commands).toHaveLength(0);

    observe = async () => allowedCreateAuthority;
    await act(async () => root.render(h(Harness, { locale: 'en', session: 'signed-in' })));
    await waitFor(() => expect(host.textContent).toContain(m.identity_intake_authority_allowed()));
    await act(async () => user.selectOptions(canvas.getByRole('combobox', { name: m.catalogue_create_type() }), typeId));
    if (typeMeaning?.description) expect(host.textContent).toContain(typeMeaning.description);
    await act(async () => user.type(canvas.getByRole('textbox', { name: m.catalogue_create_language() }), 'en'));
    await act(async () => user.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Reviewed place'));
    const dirty = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    if (urlFact) {
      await act(async () =>
        user.selectOptions(canvas.getByRole('combobox', { name: m.music_context_create_add_fact() }), urlFact),
      );
      const button = canvas
        .getAllByRole('button', { name: m.music_context_create_add_fact() })
        .find((node) => !(node as HTMLButtonElement).disabled);
      await act(async () => user.click(button!));
      const row = host.querySelector('[data-slot="music-context-initial-fact"]') as HTMLElement;
      await act(async () => user.type(row.querySelector('input, textarea') as HTMLElement, 'https://example.org/place'));
    }
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(host.querySelector('[data-music-context-create-review]')).not.toBeNull());
    observe = async () => ({ state: 'refused', reason: 'permission' });
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() =>
      expect(canvas.getByRole('alert').textContent).toContain(m.identity_intake_authority_refused_permission()),
    );
    expect(commands).toHaveLength(0);
    observe = async () => allowedCreateAuthority;
    await act(async () => user.click(canvas.getByRole('button', { name: m.identity_intake_authority_retry() })));
    await waitFor(() => expect(host.textContent).toContain(m.identity_intake_authority_allowed()));
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.item.type).toBe(typeId);
    expect(canvas.getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toBe(
      `/en/subjects/${createdId}/reviewed-place`,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
