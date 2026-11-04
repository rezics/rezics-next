import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useMemo, useRef, useState } from 'react';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { CreateResult, CreateType, CreatedReader, InitialSubject } from '../src/features/catalogue/create-subject';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import * as start from '../.storybook/react-start';
import { withConcreteReleaseDescriptors } from '../src/kernel/fake/release-fidelity';
import { allowedCreateAuthority, type CreateAuthority } from '../src/features/catalogue/identity-intake';
import { catalogueFileCreateAdmitReader } from '../src/features/catalogue/catalogue-file-create';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const release = withConcreteReleaseDescriptors(bundledRelease);
const digest = 'sha256:catalogue-file-create-eligibility';
type Viewer = { state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable'; subject: string | null; csrfToken: string | null };
const signedIn: Viewer = { state: 'signed-in', subject: 'alice', csrfToken: 'csrf-alice' };
let viewer: Viewer = signedIn;
let observe: () => Promise<CreateAuthority> = async () => allowedCreateAuthority;
const commands: { item: InitialSubject; key: string }[] = [];
let submitImpl: (command: { item: InitialSubject; key: string }) => Promise<CreateResult> = async () => ({
  ok: false,
  reason: 'unavailable',
});
let readImpl: (id: string) => Promise<CreatedReader> = async () => ({ state: 'unavailable' });

mock.module('../src/session/query', () => ({ useSession: () => viewer }));
mock.module('../src/features/catalogue/create-subject-actions', () => ({
  readCatalogueCreateEligibility: () => observe(),
  readCreatedCatalogueSubject: async ({ data }: { data: string }) => readImpl(data),
}));
mock.module('../src/features/catalogue/catalogue-file-create-actions', () => ({
  loadCatalogueFileCreate: async () => ({ ok: true as const, digest, release }),
  createCatalogueFileSubject: async ({ data }: { data: { item: InitialSubject; key: string } }) => {
    commands.push({ item: data.item, key: data.key });
    const result = await submitImpl(data);
    return result.ok
      ? { ...result, reader: catalogueFileCreateAdmitReader(result.reader, result.id, release, data.item.type) }
      : result;
  },
}));
mock.module('../src/features/catalogue/relation-editor-search', () => ({ relationTargetSearch: async () => [] }));

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
  } = await import('../src/features/catalogue/catalogue-file-create');
  type CatalogueFileCreateFact = { key: string; statement: StatementInput };
  type CatalogueFileCreateItem = InitialSubject & { statements: Record<string, StatementInput[]> };
  const { m } = await import('../src/paraglide/messages.js');
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
        fields: (type: string, disabled: boolean, canEdit: () => boolean, invalidate?: () => void) => (
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
    await act(async () =>
      user.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Reviewed file'),
    );
    async function addProperty(property: string) {
      const add = canvas.getByRole('combobox', { name: m.catalogue_file_create_add_fact() });
      await act(async () => user.selectOptions(add, property));
      const button = canvas
        .getAllByRole('button', { name: m.correction_add() })
        .find((node) => !(node as HTMLButtonElement).disabled);
      await act(async () => user.click(button!));
    }
    await addProperty('schema:sameAs');
    await addProperty('wdt:P4092');
    expect(host.textContent).toContain(m.catalogue_file_hash_statement());
    const same = host.querySelector('[id^="catalogue-file-initial-"]') as HTMLElement;
    const urls = within(same).getAllByRole('textbox');
    await act(async () => user.type(urls[0]!, 'https://example.org/file'));
    await act(async () => user.type(urls[1]!, 'https://example.org/file-source'));
    await act(async () => user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(host.querySelector('[data-catalogue-file-create-review]')).not.toBeNull());
    expect(host.textContent).toContain(m.catalogue_file_create_file_grain());
    expect(host.textContent).toContain('https://example.org/file-source');
    await act(async () =>
      user.click(canvas.getAllByRole('button', { name: m.catalogue_file_create_review_open() })[0]!),
    );
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

async function fileCreateSession() {
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
  const { CatalogueFileCreateSession } = await import('../src/features/catalogue/catalogue-file-create-session');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['session'], viewer);
  window.location.assign = () => undefined;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });
  function Harness() {
    return (
      <QueryClientProvider client={client}>
        <CatalogueFileCreateSession locale="en" initial={{ ok: true, digest, release }} />
      </QueryClientProvider>
    );
  }
  await act(async () => root.render(<Harness />));
  return {
    host,
    canvas,
    user,
    waitFor,
    client,
    m,
    admit: catalogueFileCreateAdmitReader,
    async refresh() {
      client.setQueryData(['session'], viewer);
      await act(async () => root.render(<Harness />));
    },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

async function chooseTypeAndName(
  page: Awaited<ReturnType<typeof fileCreateSession>>,
  type: string,
  label: string,
) {
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

test('the mounted file visit keeps definitions when eligibility is refused, unknown, or guest', async () => {
  commands.length = 0;
  viewer = signedIn;
  observe = async () => ({ state: 'refused', reason: 'permission' });
  const page = await fileCreateSession();
  try {
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    await chooseTypeAndName(page, 'schema:MediaObject', 'Kept draft');
    expect(
      (page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(commands).toHaveLength(0);

    observe = async () => ({ state: 'unknown', reason: 'unavailable' });
    await page.refresh();
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

test('revoking create grant after an allowed read cannot prepare a fresh file create', async () => {
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  commands.length = 0;
  const page = await fileCreateSession();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, 'schema:MediaObject', 'Stale grant file');
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() => expect(page.host.querySelector('[data-catalogue-file-create-review]')).not.toBeNull());
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

test('allowed File and FileGroup creates return the ordinary file reader', async () => {
  const fileId = '00000000-0000-4000-8000-00000000a311';
  const groupId = '00000000-0000-4000-8000-00000000a312';
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  commands.length = 0;
  submitImpl = async (command) => {
    const id = command.item.type === 'rezics:ReleaseGroup' ? groupId : fileId;
    const slug = command.item.type === 'rezics:ReleaseGroup' ? 'group' : 'file-item';
    return {
      ok: true,
      id,
      reader: {
        state: 'ready',
        href: `/en/subjects/${id}/${slug}`,
        identity: { id, type: command.item.type, label: command.item.labels.en ?? '' },
      },
    };
  };
  const page = await fileCreateSession();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, 'schema:MediaObject', 'Eligible file');
    expect(page.host.textContent).toContain(page.m.catalogue_file_create_file_grain());
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() => expect(page.host.querySelector('[data-catalogue-file-create-review]')).not.toBeNull());
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() })));
    await page.waitFor(() => expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() })).toBeDefined());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.item.type).toBe('schema:MediaObject');
    expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() }).getAttribute('href')).toBe(
      `/en/subjects/${fileId}/file-item/file`,
    );
  } finally {
    await page.close();
  }

  commands.length = 0;
  const groupPage = await fileCreateSession();
  try {
    await groupPage.waitFor(() =>
      expect(groupPage.host.textContent).toContain(groupPage.m.identity_intake_authority_allowed()),
    );
    await chooseTypeAndName(groupPage, 'rezics:ReleaseGroup', 'Eligible group');
    expect(groupPage.host.textContent).toContain(groupPage.m.catalogue_file_create_group_grain());
    await act(async () =>
      groupPage.user.click(groupPage.canvas.getByRole('button', { name: groupPage.m.catalogue_create_submit() })),
    );
    await groupPage.waitFor(() =>
      expect(groupPage.host.querySelector('[data-catalogue-file-create-review]')).not.toBeNull(),
    );
    await act(async () =>
      groupPage.user.click(groupPage.canvas.getByRole('button', { name: groupPage.m.catalogue_create_submit() })),
    );
    await groupPage.waitFor(() =>
      expect(groupPage.canvas.getByRole('link', { name: groupPage.m.catalogue_create_open() })).toBeDefined(),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.item.type).toBe('rezics:ReleaseGroup');
    expect(groupPage.canvas.getByRole('link', { name: groupPage.m.catalogue_create_open() }).getAttribute('href')).toBe(
      `/en/subjects/${groupId}/group/file`,
    );
  } finally {
    await groupPage.close();
  }
});

test('viewer replacement drops a late allowed observation; uncertain retry keeps the exact command after a later refusal', async () => {
  const fileId = '00000000-0000-4000-8000-00000000a321';
  viewer = signedIn;
  commands.length = 0;
  let pending: ((value: CreateAuthority) => void) | undefined;
  let calls = 0;
  observe = () => {
    calls += 1;
    if (calls === 1) return new Promise<CreateAuthority>((resolve) => (pending = resolve));
    return Promise.resolve({ state: 'refused', reason: 'permission' });
  };
  const page = await fileCreateSession();
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
    expect(page.canvas.getByRole('alert').textContent).toContain(
      page.m.identity_intake_authority_refused_permission(),
    );
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
    return { ok: true, id: fileId, reader: { state: 'unavailable' } };
  };
  readImpl = async (id) => {
    reads += 1;
    expect(id).toBe(fileId);
    return {
      state: 'ready',
      href: `/en/subjects/${fileId}/recovered`,
      identity: { id: fileId, type: 'schema:MediaObject', label: 'Recovered file' },
    };
  };
  const retryPage = await fileCreateSession();
  try {
    await retryPage.waitFor(() =>
      expect(retryPage.host.textContent).toContain(retryPage.m.identity_intake_authority_allowed()),
    );
    await chooseTypeAndName(retryPage, 'schema:MediaObject', 'Uncertain file');
    await act(async () =>
      retryPage.user.click(retryPage.canvas.getByRole('button', { name: retryPage.m.catalogue_create_submit() })),
    );
    await retryPage.waitFor(() => expect(retryPage.host.querySelector('[data-catalogue-file-create-review]')).not.toBeNull());
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
    await retryPage.waitFor(() => expect(retryPage.host.textContent).toContain(fileId));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.key).toBe(commands[0]!.key);
    expect(commands[1]!.item).toEqual(commands[0]!.item);
    expect(commands[0]!.item.type).toBe('schema:MediaObject');
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
