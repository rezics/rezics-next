import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { act, createContext, createElement as h, type ReactNode } from 'react';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { ConceptCreateFact } from '../src/features/catalogue/concept-create';
import type { CreateResult, CreatedReader, InitialSubject } from '../src/features/catalogue/create-subject';
import * as start from '../.storybook/react-start';
import {
  allowedCreateAuthority,
  parseIdentityIntakeRequest,
  type CreateAuthority,
} from '../src/features/catalogue/identity-intake';
import { candidateContext } from '../src/subject/candidates';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const digest = 'sha256:concept-create-eligibility';
const concept = 'skos:Concept';
const scheme = 'skos:ConceptScheme';
type Viewer = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject: string | null;
  csrfToken: string | null;
};
const signedIn: Viewer = { state: 'signed-in', subject: 'alice', csrfToken: 'csrf-alice' };
let viewer: Viewer = signedIn;
let observe: () => Promise<CreateAuthority> = async () => allowedCreateAuthority;
let intakeAuthority: CreateAuthority = allowedCreateAuthority;
let intakeMode: 'empty' | 'fail' = 'empty';
const commands: { item: InitialSubject; key: string }[] = [];
let submitImpl: (command: { item: InitialSubject; key: string }) => Promise<CreateResult> = async () => ({
  ok: false,
  reason: 'unavailable',
});
let readImpl: (id: string) => Promise<CreatedReader> = async () => ({ state: 'unavailable' });
let admitCreated: (reader: CreatedReader, id: string, release: typeof bundledRelease, type: string) => CreatedReader = (
  reader,
) => reader;

mock.module('../src/session/query', () => ({
  useSession: () => viewer,
  sessionCsrfToken: () => viewer.csrfToken,
  sessionQuery: { queryKey: ['session'] },
  exposureQuery: { queryKey: ['exposure', 'viewer'] },
  AnonymousSessionContext: createContext(false),
}));
mock.module('../src/features/catalogue/create-subject-actions', () => ({
  readCatalogueCreateEligibility: () => observe(),
  readCreatedCatalogueSubject: async ({ data }: { data: string }) => readImpl(data),
}));
mock.module('../src/features/catalogue/concept-create-actions', () => ({
  loadConceptCreate: async () => ({ ok: true as const, digest, release: bundledRelease }),
  createCatalogueConcept: async ({ data }: { data: { item: InitialSubject; key: string } }) => {
    commands.push({ item: data.item, key: data.key });
    const result = await submitImpl(data);
    return result.ok
      ? { ...result, reader: admitCreated(result.reader, result.id, bundledRelease, data.item.type) }
      : result;
  },
}));
mock.module('../src/features/catalogue/relation-editor-search', () => ({ relationTargetSearch: async () => [] }));

const { conceptAdmitCreatedReader } = await import('../src/features/catalogue/concept-create');
admitCreated = conceptAdmitCreatedReader;

async function mounted(run: (page: { host: HTMLElement }) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/concept' });
  const names =
    'window document navigator HTMLElement HTMLButtonElement HTMLFormElement HTMLInputElement HTMLSelectElement Element Node DocumentFragment Document ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[name as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await run({
      host,
      async render(node: ReactNode) {
        await act(async () => root.render(node));
      },
    } as { host: HTMLElement } & { render: (node: ReactNode) => Promise<void> });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('Concept fields distinguish scheme from concept and review multilingual terms with admitted evidence', async () => {
  await mounted(async (page) => {
    const { render, host } = page as typeof page & { render: (node: ReactNode) => Promise<void> };
    const { ConceptCreateFields } = await import('../src/features/catalogue/concept-create-fields');
    const { ConceptCreateReview } = await import('../src/features/catalogue/concept-create-review');
    const { ConceptCreateEntry } = await import('../src/features/catalogue/concept-create-entry');
    const { conceptCreateDraft, conceptCreateHolders } = await import('../src/features/catalogue/concept-create');
    const { CatalogueCurrentReading, catalogueEditor } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const Fields = catalogueEditor(ConceptCreateFields);
    const facts: ConceptCreateFact[] = [
      {
        key: '00000000-0000-4000-8000-00000000f001',
        statement: {
          property: { id: 'skos:inScheme' },
          value: { type: 'value', content: '00000000-0000-4000-8000-00000000c102' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      },
    ];
    let current = facts;
    await render(
      h('div', null, [
        h(ConceptCreateEntry, { locale: 'en' }),
        h(
          CatalogueCurrentReading,
          { visible: true, ready: true, revision: 'concept' },
          h(Fields, {
            type: 'skos:Concept',
            release: bundledRelease,
            locale: 'en',
            search: async () => [
              {
                id: '00000000-0000-4000-8000-00000000c102',
                title: 'Existing scheme',
                types: ['skos:ConceptScheme'],
                typeLabel: 'Concept Scheme',
                cover: null,
              },
            ],
            facts: current,
            disabled: false,
            canEdit: () => true,
            change: (next: ConceptCreateFact[]) => {
              current = next;
            },
            invalidate: () => undefined,
            discardTypeDraft: () => undefined,
          }),
        ),
      ]),
    );
    expect(host.textContent).toContain(m.concept_create_facts());
    expect(host.textContent).toContain(m.concept_create_optional());
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/en/catalogue/concept');
    const prepared = conceptCreateDraft(
      bundledRelease,
      { type: 'skos:Concept', labels: { en: 'Night', ja: '夜'.repeat(40) }, descriptions: { ja: '時間' } },
      current,
    );
    await render(
      h(ConceptCreateReview, {
        item: prepared.item,
        holders: conceptCreateHolders(current),
        release: bundledRelease,
        locale: 'en',
        stale: false,
        factsId: 'concept-initial-facts',
        onJump: () => undefined,
      }),
    );
    expect(host.querySelector('[data-concept-create-review]')).toBeTruthy();
    expect(host.textContent).toContain(m.concept_create_grain_concept());
    expect(host.textContent).toContain('夜'.repeat(40));
    expect(host.textContent).toContain('skos:inScheme');
    expect(host.textContent).not.toContain('skos:closeMatch');
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'scheme' },
        h(Fields, {
          type: 'skos:ConceptScheme',
          release: bundledRelease,
          locale: 'en',
          search: async () => [],
          facts: [],
          disabled: false,
          canEdit: () => true,
          change: () => undefined,
          invalidate: () => undefined,
          discardTypeDraft: () => undefined,
        }),
      ),
    );
    expect(host.textContent).toContain(m.concept_create_scheme_optional());
  });
});

async function conceptCreateSession(options?: { token?: string; prepare?: (storage: Storage) => string | undefined }) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/concept' });
  const assigned: string[] = [];
  window.location.assign = ((url: string) => {
    assigned.push(String(url));
  }) as typeof window.location.assign;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    sessionStorage: window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const previousFetch = globalThis.fetch;
  window.fetch = (async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/catalogue/identity-intake')) return new Response('not found', { status: 404 });
    if (intakeMode === 'fail') throw new TypeError('Identity search unavailable');
    const binding = parseIdentityIntakeRequest(new URL(url, 'https://site.test').searchParams);
    if (!binding) return Response.json({ status: 'invalid' }, { status: 400 });
    return Response.json({
      binding,
      status: 'empty',
      viewer: { state: viewer.state },
      actions: {
        openExisting: false,
        continueWithResults: true,
        continueUnverified: false,
        retry: false,
        createAuthority: intakeAuthority,
      },
      results: [],
    });
  }) as typeof fetch;
  globalThis.fetch = window.fetch;
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { ConceptCreateSession } = await import('../src/features/catalogue/concept-create-session');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['session'], viewer);
  const token = options?.prepare?.(window.sessionStorage) ?? options?.token;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  let root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });
  function Harness() {
    return (
      <QueryClientProvider client={client}>
        <ConceptCreateSession
          locale="en"
          initial={{ ok: true, digest, release: bundledRelease }}
          {...(token ? { token } : {})}
        />
      </QueryClientProvider>
    );
  }
  await act(async () => root.render(<Harness />));
  return {
    host,
    canvas,
    user,
    waitFor,
    assigned,
    m,
    storage: window.sessionStorage,
    async refresh() {
      client.setQueryData(['session'], viewer);
      await act(async () => root.render(<Harness />));
    },
    async remount() {
      await act(async () => root.unmount());
      root = createRoot(host as unknown as HTMLElement);
      await act(async () => root.render(<Harness />));
    },
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = previousFetch;
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

async function chooseTypeAndName(page: Awaited<ReturnType<typeof conceptCreateSession>>, type: string, label: string) {
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

async function confirmIdentity(page: Awaited<ReturnType<typeof conceptCreateSession>>) {
  await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.identity_intake_search() })));
  await page.waitFor(() =>
    expect(page.canvas.getByRole('button', { name: page.m.identity_intake_continue() })).toBeDefined(),
  );
  await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.identity_intake_continue() })));
}

function submitButton(page: Awaited<ReturnType<typeof conceptCreateSession>>) {
  return page.canvas.getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement;
}

test('the mounted Concept visit keeps Types when eligibility is refused, unknown, or guest', async () => {
  commands.length = 0;
  viewer = signedIn;
  observe = async () => ({ state: 'refused', reason: 'permission' });
  intakeAuthority = { state: 'refused', reason: 'permission' };
  const page = await conceptCreateSession();
  try {
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    await chooseTypeAndName(page, concept, 'Kept draft');
    expect(submitButton(page).disabled).toBe(true);
    expect(commands).toHaveLength(0);

    observe = async () => ({ state: 'unknown', reason: 'unavailable' });
    intakeAuthority = { state: 'unknown', reason: 'unavailable' };
    await act(async () =>
      page.user.click(page.canvas.getByRole('button', { name: page.m.identity_intake_authority_retry() })),
    );
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(page.m.identity_intake_authority_unknown()),
    );
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    expect(submitButton(page).disabled).toBe(true);

    viewer = { state: 'signed-out', subject: null, csrfToken: null };
    await page.refresh();
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_guest()));
    expect(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() })).toBeDefined();
    expect(submitButton(page).disabled).toBe(true);
    expect(commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('revoking create grant after an allowed Concept review cannot prepare a fresh write', async () => {
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  intakeAuthority = allowedCreateAuthority;
  intakeMode = 'empty';
  commands.length = 0;
  const page = await conceptCreateSession();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, concept, 'Stale grant concept');
    await confirmIdentity(page);
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() => expect(page.host.querySelector('[data-concept-create-review]')).not.toBeNull());
    observe = async () => ({ state: 'refused', reason: 'permission' });
    intakeAuthority = { state: 'refused', reason: 'permission' };
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(submitButton(page).disabled).toBe(true);
    expect(commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('Concept Type drafts stay per Type; viewer replacement drops a late allowed observation', async () => {
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  intakeAuthority = allowedCreateAuthority;
  commands.length = 0;
  const page = await conceptCreateSession();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, concept, 'Night');
    await act(async () =>
      page.user.selectOptions(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() }), scheme),
    );
    await act(async () =>
      page.user.type(page.canvas.getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Times'),
    );
    await act(async () =>
      page.user.selectOptions(page.canvas.getByRole('combobox', { name: page.m.catalogue_create_type() }), concept),
    );
    expect(
      (page.canvas.getByRole('textbox', { name: page.m.catalogue_create_label() }) as HTMLInputElement).value,
    ).toBe('Night');
  } finally {
    await page.close();
  }

  let pending: ((value: CreateAuthority) => void) | undefined;
  let calls = 0;
  observe = () => {
    calls += 1;
    if (calls === 1) return new Promise<CreateAuthority>((resolve) => (pending = resolve));
    return Promise.resolve({ state: 'refused', reason: 'permission' });
  };
  intakeAuthority = { state: 'refused', reason: 'permission' };
  const replaced = await conceptCreateSession();
  try {
    await replaced.waitFor(() =>
      expect(replaced.host.textContent).toContain(replaced.m.identity_intake_authority_reading()),
    );
    expect(replaced.canvas.getByRole('combobox', { name: replaced.m.catalogue_create_type() })).toBeDefined();
    viewer = { state: 'signed-in', subject: 'bob', csrfToken: 'csrf-bob' };
    await replaced.refresh();
    await replaced.waitFor(() =>
      expect(replaced.canvas.getByRole('alert').textContent).toContain(
        replaced.m.identity_intake_authority_refused_permission(),
      ),
    );
    pending?.(allowedCreateAuthority);
    await act(async () => undefined);
    expect(replaced.canvas.getByRole('alert').textContent).toContain(
      replaced.m.identity_intake_authority_refused_permission(),
    );
    expect(submitButton(replaced).disabled).toBe(true);
    expect(commands).toHaveLength(0);
  } finally {
    await replaced.close();
  }
});

test('uncertain Concept retry keeps the exact command; known-id recovery reads without another write', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c401';
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  intakeAuthority = allowedCreateAuthority;
  intakeMode = 'empty';
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
      identity: { id: createdId, type: concept, label: 'Recovered concept' },
    };
  };
  const page = await conceptCreateSession();
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, concept, 'Uncertain concept');
    await confirmIdentity(page);
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() => expect(page.host.querySelector('[data-concept-create-review]')).not.toBeNull());
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('button', { name: page.m.catalogue_create_retry() })).toBeDefined(),
    );
    observe = async () => ({ state: 'refused', reason: 'permission' });
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_retry() })));
    await page.waitFor(() => expect(page.host.textContent).toContain(createdId));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.key).toBe(commands[0]!.key);
    expect(commands[1]!.item).toEqual(commands[0]!.item);
    expect(commands[0]!.item.type).toBe(concept);
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_retry() })));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() })).toBeDefined(),
    );
    expect(reads).toBe(1);
    expect(commands).toHaveLength(2);
  } finally {
    await page.close();
  }
});

test('a remounted detour restores its acknowledged UUID, rereads it, and returns only a fresh disclosure', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c403';
  const sourceId = '00000000-0000-4000-8000-00000000a075';
  const holder = '00000000-0000-4000-8000-00000000b002';
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  intakeAuthority = allowedCreateAuthority;
  intakeMode = 'empty';
  commands.length = 0;
  submitImpl = async () => ({ ok: true, id: createdId, reader: { state: 'unavailable' } });
  let reads = 0;
  readImpl = async (id) => {
    expect(id).toBe(createdId);
    reads += 1;
    if (reads === 1) return { state: 'unavailable' };
    if (reads === 2) {
      return {
        state: 'ready',
        href: `/en/subjects/${createdId}/stale-type`,
        identity: { id: createdId, type: 'wd:Q95074', label: 'Stale Type identity' },
      };
    }
    return {
      state: 'ready',
      href: `/en/subjects/${createdId}/recovered`,
      identity: { id: createdId, type: concept, label: 'Recovered concept' },
    };
  };
  const token = crypto.randomUUID();
  const page = await conceptCreateSession({
    prepare(storage) {
      storage.setItem(
        `rezics:classification-create-handoff:${token}`,
        JSON.stringify({
          version: 1,
          token,
          createdAt: Date.now(),
          sourceId,
          sourceLabel: 'The source',
          sourceType: 'wd:Q95074',
          returnPath: '/en/catalogue/character',
          reader: 'alice',
          context: candidateContext,
          releaseDigest: 'catalogue:1',
          propertyId: 'schema:keywords',
          propertyLabel: 'keywords',
          holder,
          originalStatementId: null,
          targets: [concept],
          drafts: [
            {
              holder,
              property: 'schema:keywords',
              source: null,
              included: true,
              statement: {
                property: { id: 'schema:keywords' },
                value: { type: 'value', content: '' },
                qualifiers: [],
                references: [],
                rank: 'normal',
              },
              baseline: null,
            },
          ],
          reviewFingerprint: '',
          phase: 'creating',
        }),
      );
      return token;
    },
  });
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await chooseTypeAndName(page, concept, 'Recovered concept');
    await confirmIdentity(page);
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() => expect(page.host.querySelector('[data-concept-create-review]')).not.toBeNull());
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() => expect(page.host.textContent).toContain(createdId));
    expect(commands).toHaveLength(1);

    await page.remount();
    await page.waitFor(() => expect(page.host.textContent).toContain(createdId));
    expect(commands).toHaveLength(1);
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_retry() })));
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.catalogue_create_reader_unavailable()));
    expect(page.host.textContent).toContain(createdId);
    expect(commands).toHaveLength(1);

    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_retry() })));
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.catalogue_create_reader_stale()));
    expect(page.host.textContent).toContain(createdId);
    expect(page.canvas.queryByRole('button', { name: page.m.classification_create_return_to_draft() })).toBeNull();

    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_retry() })));
    await page.waitFor(() =>
      expect(page.canvas.getByRole('link', { name: page.m.catalogue_create_open() })).toBeDefined(),
    );
    await page.waitFor(() => expect(page.host.textContent).toContain('Recovered concept'));
    expect(page.host.textContent).toContain(concept);
    expect(page.host.textContent).toContain('schema:Thing');
    expect(reads).toBe(3);
    await act(async () =>
      page.user.click(page.canvas.getByRole('button', { name: page.m.classification_create_return_to_draft() })),
    );
    expect(page.assigned.at(-1)).toContain('/en/catalogue/character?classificationHandoff=');
    expect(reads).toBe(4);
    expect(commands).toHaveLength(1);

    const handoffKey = `rezics:classification-create-handoff:${token}`;
    const raw = page.storage.getItem(handoffKey);
    expect(raw).toBeTruthy();
    const expired = JSON.parse(raw!) as { createdAt: number };
    expired.createdAt = Date.now() - 31 * 60 * 1000;
    page.storage.setItem(handoffKey, JSON.stringify(expired));
    await page.remount();
    await page.waitFor(() => expect(page.host.textContent).toContain(createdId));
    expect(page.host.textContent).toContain(page.m.classification_create_handoff_invalid());
    expect(page.canvas.queryByRole('button', { name: page.m.classification_create_return_to_draft() })).toBeNull();
    expect(commands).toHaveLength(1);

    let readStarted = false;
    let resolveLateRead: ((reader: CreatedReader) => void) | undefined;
    readImpl = async (id) => {
      expect(id).toBe(createdId);
      readStarted = true;
      return new Promise((resolve) => {
        resolveLateRead = resolve;
      });
    };
    await page.remount();
    await page.waitFor(() => expect(page.host.textContent).toContain(createdId));
    await act(async () => page.user.click(page.canvas.getByRole('button', { name: page.m.catalogue_create_retry() })));
    await page.waitFor(() => expect(readStarted).toBe(true));
    viewer = { state: 'signed-in', subject: 'bob', csrfToken: 'csrf-bob' };
    await page.refresh();
    await page.waitFor(() => expect(page.host.textContent).not.toContain(createdId));
    await act(async () =>
      resolveLateRead?.({
        state: 'ready',
        href: `/en/subjects/${createdId}/recovered`,
        identity: { id: createdId, type: concept, label: 'Recovered concept' },
      }),
    );
    expect(page.host.textContent).not.toContain(createdId);
    expect(page.host.textContent).not.toContain('Recovered concept');
    expect(page.canvas.queryByRole('button', { name: page.m.classification_create_return_to_draft() })).toBeNull();
    expect(commands).toHaveLength(1);
  } finally {
    await page.close();
  }
});

test('classification return records the admitted identity; expired handoff keeps the known create', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c402';
  const sourceId = '00000000-0000-4000-8000-00000000a074';
  const holder = '00000000-0000-4000-8000-00000000b001';
  viewer = signedIn;
  observe = async () => allowedCreateAuthority;
  intakeAuthority = allowedCreateAuthority;
  intakeMode = 'empty';
  commands.length = 0;
  let returnReads = 0;
  readImpl = async (id) => {
    returnReads += 1;
    return {
      state: 'ready',
      href: `/en/subjects/${id}/night`,
      identity: { id, type: concept, label: 'Night' },
    };
  };
  submitImpl = async (command) => ({
    ok: true,
    id: createdId,
    reader: {
      state: 'ready',
      href: `/en/subjects/${createdId}/night`,
      identity: { id: createdId, type: command.item.type, label: command.item.labels.en ?? '' },
    },
  });
  const { createClassificationCreateHandoff, readClassificationCreateHandoff, snapshotClassificationDrafts } =
    await import('../src/features/catalogue/classification-create-return');
  const snapshots = snapshotClassificationDrafts([
    {
      holder,
      property: 'schema:keywords',
      source: null,
      included: true,
      baseline: null,
      statement: {
        property: { id: 'schema:keywords' },
        value: { type: 'value', content: '' },
        qualifiers: [],
        references: [],
        rank: 'preferred',
      },
    },
  ]);
  function seedHandoff() {
    return createClassificationCreateHandoff({
      sourceId,
      sourceLabel: 'The traveler',
      sourceType: 'wd:Q95074',
      returnPath: '/en/catalogue/character',
      reader: 'alice',
      context: candidateContext,
      releaseDigest: digest,
      propertyId: 'schema:keywords',
      propertyLabel: 'keywords',
      holder,
      originalStatementId: null,
      targets: [concept],
      drafts: snapshots!,
      reviewFingerprint: '',
    })?.token;
  }
  let token = '';
  const page = await conceptCreateSession({
    prepare: () => {
      token = seedHandoff() ?? '';
      return token;
    },
  });
  try {
    expect(token).toBeTruthy();
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.classification_create_source()));
    await chooseTypeAndName(page, concept, 'Night');
    await confirmIdentity(page);
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() => expect(page.host.querySelector('[data-concept-create-review]')).not.toBeNull());
    await act(async () => page.user.click(submitButton(page)));
    await page.waitFor(() => expect(page.host.textContent).toContain(createdId));
    expect(commands).toHaveLength(1);
    expect(readClassificationCreateHandoff(token)?.identity).toMatchObject({
      id: createdId,
      type: concept,
      label: 'Night',
    });
    await act(async () =>
      page.user.click(page.canvas.getByRole('button', { name: page.m.classification_create_return_to_draft() })),
    );
    await page.waitFor(() => expect(page.assigned[0]).toContain(`classificationHandoff=${token}`));
    expect(returnReads).toBe(1);
    expect(commands).toHaveLength(1);
  } finally {
    await page.close();
  }

  commands.length = 0;
  let expiredToken = '';
  const expiredPage = await conceptCreateSession({
    prepare: () => {
      expiredToken = seedHandoff() ?? '';
      return expiredToken;
    },
  });
  try {
    await expiredPage.waitFor(() =>
      expect(expiredPage.host.textContent).toContain(expiredPage.m.identity_intake_authority_allowed()),
    );
    await chooseTypeAndName(expiredPage, concept, 'Kept identity');
    await confirmIdentity(expiredPage);
    await act(async () => expiredPage.user.click(submitButton(expiredPage)));
    await expiredPage.waitFor(() =>
      expect(expiredPage.host.querySelector('[data-concept-create-review]')).not.toBeNull(),
    );
    await act(async () => expiredPage.user.click(submitButton(expiredPage)));
    await expiredPage.waitFor(() => expect(expiredPage.host.textContent).toContain(createdId));
    const raw = expiredPage.storage.getItem(`rezics:classification-create-handoff:${expiredToken}`);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw!) as { createdAt: number };
    stored.createdAt = Date.now() - 31 * 60 * 1000;
    expiredPage.storage.setItem(`rezics:classification-create-handoff:${expiredToken}`, JSON.stringify(stored));
    await act(async () =>
      expiredPage.user.click(
        expiredPage.canvas.getByRole('button', { name: expiredPage.m.classification_create_return_to_draft() }),
      ),
    );
    await expiredPage.waitFor(() => expect(returnReads).toBe(2));
    expect(expiredPage.host.textContent).toContain(createdId);
    expect(expiredPage.assigned).toHaveLength(0);
    expect(commands).toHaveLength(1);
  } finally {
    await expiredPage.close();
  }
});
