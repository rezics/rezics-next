import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useMemo, useRef, useState } from 'react';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { CreateResult, CreateType, InitialSubject } from '../src/features/catalogue/create-subject';
import * as start from '../.storybook/react-start';
import { withConcreteReleaseDescriptors } from '../src/kernel/fake/release-fidelity';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('A contributor reviews a file grain, repairs a nested citation, copies evidence and returns to the file reader', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/file' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
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
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { CatalogueFileCreateFields } = await import('../src/features/catalogue/catalogue-file-create-fields');
  const { CatalogueFileCreateReview } = await import('../src/features/catalogue/catalogue-file-create-review');
  const {
    catalogueFileCreateAdmitReader,
    catalogueFileCreateControl,
    catalogueFileCreateDraft,
    catalogueFileCreateHolders,
    catalogueFileCreatePreparedFacts,
    catalogueFileCreateTypes,
    type CatalogueFileCreateFact,
    type CatalogueFileCreateItem,
  } = await import('../src/features/catalogue/catalogue-file-create');
  const { m } = await import('../src/paraglide/messages.js');
  const release = withConcreteReleaseDescriptors(bundledRelease);
  const createdId = '00000000-0000-4000-8000-00000000a301';
  const posts: InitialSubject[] = [];
  const navigations: string[] = [];
  const factsId = 'catalogue-file-initial-facts';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });

  function Harness() {
    const [factsByType, setFactsByType] = useState<Record<string, CatalogueFileCreateFact[]>>({});
    const prepared = useRef<{ release: Release; holders: ReturnType<typeof catalogueFileCreateHolders> }>();
    const types = catalogueFileCreateTypes(release, 'en') as CreateType[];
    const profile = useMemo(
      () => ({
        title: m.catalogue_file_create_title(),
        intro: m.catalogue_file_create_intro(),
        href: '/en/catalogue/file',
        scope: 'catalogue-file-create-test',
        metadata: { ready: true, pending: false, failure: null, types },
        retainTypeDrafts: true,
        initialLanguage: 'en',
        fields: (
          type: string,
          disabled: boolean,
          canEdit: () => boolean,
          invalidate?: () => void,
        ) => (
          <CatalogueFileCreateFields
            type={type}
            release={release}
            locale="en"
            search={async () => []}
            facts={factsByType[type] ?? []}
            disabled={disabled}
            canEdit={canEdit}
            invalidate={invalidate ?? (() => undefined)}
            discardTypeDraft={() => undefined}
            change={(next) =>
              setFactsByType((current) => {
                const copy = { ...current };
                if (next.length) copy[type] = next;
                else delete copy[type];
                return copy;
              })
            }
          />
        ),
        prepare: (initial: InitialSubject) => {
          const facts = catalogueFileCreatePreparedFacts(factsByType[initial.type] ?? [], release);
          const result = catalogueFileCreateDraft(release, initial, facts);
          prepared.current = { release, holders: catalogueFileCreateHolders(facts) };
          return result;
        },
        control: (pointer: string, type: string) => {
          const snapshot = prepared.current;
          if (!snapshot) return undefined;
          return catalogueFileCreateControl(
            pointer,
            snapshot.holders,
            factsByType[type] ?? [],
            type,
            snapshot.release,
            'en',
            factsId,
          );
        },
        review: (state: { item: InitialSubject; stale: boolean }) => {
          const snapshot = prepared.current;
          if (!snapshot) return null;
          return (
            <CatalogueFileCreateReview
              item={state.item as CatalogueFileCreateItem}
              holders={snapshot.holders}
              release={snapshot.release}
              locale="en"
              stale={state.stale}
              factsId={factsId}
              onJump={(id) => host.querySelector<HTMLElement>(`[id="${id}"]`)?.focus()}
            />
          );
        },
      }),
      [factsByType, types],
    );
    return (
      <CreateSubjectForm
        locale="en"
        session="signed-in"
        transport={{
          submit: async (command) => {
            posts.push(command.item);
            const result: CreateResult = {
              ok: true,
              id: createdId,
              reader: catalogueFileCreateAdmitReader(
                {
                  state: 'ready',
                  href: `/en/subjects/${createdId}/reviewed-file`,
                  identity: { id: createdId, type: command.item.type, label: 'Reviewed file' },
                },
                createdId,
                release,
                command.item.type,
              ),
            };
            return result;
          },
          read: async () => ({ state: 'unavailable' }),
        }}
        onNavigate={(href) => navigations.push(href)}
        profile={profile}
      />
    );
  }

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    const type = canvas.getByRole('combobox', { name: m.catalogue_create_type() });
    await act(async () => user.selectOptions(type, 'schema:MediaObject'));
    expect(host.textContent).toContain(m.catalogue_file_create_file_grain());
    expect(host.textContent).toContain(m.catalogue_file_create_identity());
    await act(async () => user.selectOptions(type, 'rezics:ReleaseGroup'));
    expect(host.textContent).toContain(m.catalogue_file_create_group_grain());
    await act(async () => user.selectOptions(type, 'schema:MediaObject'));
    await act(async () => user.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Reviewed file'));
    const add = canvas.getByRole('combobox', { name: m.catalogue_file_create_add_fact() });
    await act(async () => user.selectOptions(add, 'schema:sameAs'));
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_file_create_add_fact() })));
    await act(async () => user.selectOptions(add, 'schema:sha256'));
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_file_create_add_fact() })));
    expect(host.textContent).toContain(m.catalogue_file_hash_statement());
    const same = host.querySelector('[id^="catalogue-file-initial-"]') as HTMLElement;
    const urls = within(same).getAllByRole('textbox');
    await act(async () => user.type(urls[0]!, 'https://example.org/file'));
    await act(async () => user.type(urls[1]!, 'https://example.org/file-source'));
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(host.querySelector('[data-catalogue-file-create-review]')).not.toBeNull());
    expect(host.textContent).toContain(m.catalogue_file_create_file_grain());
    expect(host.textContent).toContain('https://example.org/file-source');
    await act(async () => user.click(canvas.getAllByRole('button', { name: m.catalogue_file_create_review_open() })[0]!));
    await act(async () => user.keyboard('{Tab}'));
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.type).toBe('schema:MediaObject');
    expect(posts[0]!.statements!['schema:sameAs']![0]!.rank).toBe('normal');
    expect(canvas.getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toBe(
      `/en/subjects/${createdId}/reviewed-file/file`,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
