import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FactCommand } from '../src/features/catalogue/subject-facts';
import * as start from '../.storybook/react-start';
import type { LiteraryRead } from '../src/features/catalogue/literary-profile';
import type { EditorRead } from '../src/features/catalogue/statement-editor';
import { LiteraryProfileEntry } from '../src/features/catalogue/literary-profile-entry';
import { LiteraryCurrentVisitAdmission } from '../src/features/catalogue/literary-current-visit-view';
import {
  literaryCurrentVisitSearch,
  parseLiteraryCurrentVisit,
} from '../src/features/catalogue/literary-current-visit';
import { literaryAddress } from '../src/features/catalogue/literary-reader/navigation';
import type { SubjectPageData } from '../src/features/pages/subject';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { candidateContext } from '../src/subject/candidates';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000941';
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000942';
const context = '0192f3a0-6c1e-7b2a-9d4e-000000000943';

test('public literary entry refuses a Realm editor before mount and offers a fresh independent Global visit', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/' + id + '/book' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let mounts = 0;
  function Editor() {
    mounts++;
    return <p>Current Global editor</p>;
  }
  const source = `/en/subjects/${id}/book?realm=${realm}&context=${context}#literary-reader`;
  try {
    await act(async () =>
      root.render(
        <LiteraryProfileEntry
          id={id}
          type="schema:Book"
          label="Book"
          locale="en"
          realm={realm}
          context={context}
          source={source}
        />,
      ),
    );
    const href = host.querySelector('a')!.getAttribute('href')!;
    const input = parseLiteraryCurrentVisit(new URL(href, 'https://site.test').search, id, 'en');
    expect(input).toEqual({ kind: 'visit', visit: { context, realm, type: 'schema:Book', source } });
    const globalHref = `/en/subjects/${id}/_/literary`;
    await act(async () =>
      root.render(
        <LiteraryCurrentVisitAdmission input={input} locale="en" globalHref={globalHref}>
          <Editor />
        </LiteraryCurrentVisitAdmission>,
      ),
    );
    expect(mounts).toBe(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Global');
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([source, globalHref]);
    const fresh = parseLiteraryCurrentVisit(new URL(globalHref, 'https://site.test').search, id, 'en');
    expect(fresh).toEqual({ kind: 'direct' });
    await act(async () =>
      root.render(
        <LiteraryCurrentVisitAdmission input={fresh} locale="en" globalHref={globalHref}>
          <Editor />
        </LiteraryCurrentVisitAdmission>,
      ),
    );
    expect(mounts).toBe(1);
    expect(host.textContent).toContain('Current Global editor');
    for (const search of [
      '?context=' + context,
      '?unknown=1',
      new URL(href, 'https://site.test').search.replace('book', '%FF'),
      '?source=' + 'é'.repeat(1100),
      new URL(href, 'https://site.test').search + '&realm=' + realm,
      new URL(href, 'https://site.test').search.replace(context, candidateContext),
    ]) {
      const invalid = parseLiteraryCurrentVisit(search, id, 'en');
      expect(invalid.kind).toBe('invalid');
      await act(async () =>
        root.render(
          <LiteraryCurrentVisitAdmission input={invalid} locale="en" globalHref={globalHref}>
            <Editor />
          </LiteraryCurrentVisitAdmission>,
        ),
      );
      expect(mounts).toBe(1);
    }
    await act(async () => root.render(<LiteraryProfileEntry id={id} type="bf:Instance" locale="en" />));
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(globals)) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});

test('a current visit inspects one fresh exact assertion, retires stale and late reveals, and returns through its Subject address', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('../src/features/pages/showcase-work/tags-view', () => ({ WorkConceptTagsRoute: () => null }));

  const { literaryFixture, literaryWorkId } = await import('../src/kernel/fake/catalogue-literary-profile');
  const { Window } = await import(
    createRequire(createRequire(import.meta.url).resolve('@puckeditor/core')).resolve('happy-dom')
  );
  const { SubjectPage, subjectPageTitle } = await import('../src/features/pages/subject');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = literaryFixture('ready', 'en', 'schema:Book', true);
  const loaded = await fixture.transport.load();
  if (!loaded.ok || !loaded.current) throw new Error('Expected a current literary profile');
  const actions = {
    subject: {
      state: 'available' as const,
      actions: [{ action: 'subject:read', operations: ['subject.list_candidates'] }],
    },
    context: {
      state: 'available' as const,
      actions: [{ action: 'statement:propose', operations: ['subject.propose'] }],
    },
  };
  const current = structuredClone(loaded.current);
  current.actions = actions;
  const statements = current.public.subject.statements['schema:wordCount']!;
  const first = statements[0]!;
  const duplicate = structuredClone(first);
  duplicate.id = '00000000-0000-4000-8000-000000000101';
  duplicate.references[0]!.parts[0]!.value = { type: 'value', content: 'https://selected.example/work' };
  statements.push(duplicate);
  const initialProfile: LiteraryRead = { ok: true, release: current.release, current };
  const publicPage = (title: string): SubjectPageData => {
    const page = structuredClone(recordedPage) as unknown as SubjectPageData;
    page.subject = literaryWorkId;
    page.context = { id: candidateContext, population: { kind: 'global' } };
    page.catalogue = {
      state: 'released',
      type: 'schema:Book',
      digest: current.release.digest,
      definitions: { types: current.release.types, properties: current.release.properties },
    };
    page.reads.r0 = {
      status: 200,
      body: {
        ...structuredClone(current.public),
        subject: {
          ...structuredClone(current.public.subject),
          labels: { ...current.public.subject.labels, en: title },
        },
        summary: null,
      },
    };
    return page;
  };
  const publicMessages = {
    unknown: 'Unknown',
    none: 'None',
    unlabelled: 'Unlabelled',
    sources: 'Sources',
    aliases: 'Aliases',
    search: 'Search',
  };
  const globalContext = { id: candidateContext, population: { kind: 'global' as const } };
  const sourceA = literaryAddress({
    id: literaryWorkId,
    label: subjectPageTitle(publicPage('An original literary work'), 'en'),
    locale: 'en',
    view: 'overview',
    context: globalContext,
  });
  let freshAnswer: EditorRead = structuredClone(current);
  let profileAnswer: LiteraryRead = structuredClone(initialProfile);
  const profileRequests: Record<string, unknown>[] = [];
  const correctionRequests: Record<string, unknown>[] = [];
  const proposalCalls: (FactCommand & { expectedReader: string })[] = [];
  let nextRead: ReturnType<typeof deferred<EditorRead>> | undefined;
  mock.module('../src/features/catalogue/literary-profile-actions', () => ({
    loadLiteraryProfile: async ({ data }: { data: Record<string, unknown> }) => {
      profileRequests.push(data);
      return structuredClone(profileAnswer);
    },
    createCatalogueLiteraryWork: async () => ({ ok: false, reason: 'denied' }),
  }));
  mock.module('../src/features/catalogue/statement-editor-actions', () => ({
    readCorrection: async ({ data }: { data: Record<string, unknown> }) => {
      correctionRequests.push(data);
      const pending = nextRead;
      if (pending) {
        nextRead = undefined;
        pending.entered.resolve();
        return pending.promise;
      }
      return structuredClone(freshAnswer);
    },
    readCorrectionReview: async () => ({ ok: false, reason: 'unavailable' }),
    confirmCorrection: async () => ({ ok: false, reason: 'unavailable' }),
  }));
  mock.module('../src/features/catalogue/subject-facts-actions', () => ({
    submitFactCorrection: async ({ data }: { data: FactCommand & { expectedReader: string } }) => {
      proposalCalls.push(structuredClone(data));
      if (data.statement.property.id === 'schema:wordCount')
        return {
          ok: true,
          kind: 'proposed-awaiting-review',
          candidate: '00000000-0000-4000-8000-00000000b002',
          revision: 2,
        };
      throw new Error('Lost proposal response');
    },
  }));
  mock.module('../src/features/catalogue/create-subject-actions', () => ({
    readCatalogueCreateEligibility: async () => ({ state: 'unavailable' }),
    readCreatedCatalogueSubject: async () => ({ state: 'unavailable' }),
  }));
  mock.module('../src/features/catalogue/authored-field-actions', () => ({
    loadAuthoredField: async () => ({ ok: false, reason: 'unavailable' }),
    submitAuthoredField: async () => ({ ok: false, reason: 'unavailable' }),
    loadAuthoredReview: async () => ({ comparison: { ok: false, reason: 'unavailable' }, body: null }),
    confirmAuthoredField: async () => ({ ok: false, reason: 'unavailable' }),
  }));
  mock.module('../src/features/catalogue/relation-editor-session', () => ({ RelationEditorSession: () => null }));
  const { LiteraryProfileSession } = await import('../src/features/catalogue/literary-profile-session');

  const reader = '0192f3a0-6c1e-7b2a-9d4e-000000000944';
  const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000942';
  const realmContext = '0192f3a0-6c1e-7b2a-9d4e-000000000943';
  const sourceB = literaryAddress({
    id: literaryWorkId,
    label: 'An original literary work',
    locale: 'en',
    view: 'contents',
    realm,
    context: { id: realmContext, population: { kind: 'realm', id: realm, title: 'A shelf' } },
  });
  const globalAddress = literaryCurrentVisitSearch({ context: candidateContext, type: 'schema:Book', source: sourceA });
  const realmAddress = literaryCurrentVisitSearch({
    context: realmContext,
    realm,
    type: 'schema:Book',
    source: sourceB,
  });
  const globalVisit = parseLiteraryCurrentVisit(globalAddress, literaryWorkId, 'en');
  const realmVisit = parseLiteraryCurrentVisit(realmAddress, literaryWorkId, 'en');
  expect(globalVisit.kind).toBe('visit');
  expect(realmVisit.kind).toBe('visit');

  const window = new Window({ url: `https://site.test${globalAddress}` });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'CSS',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    globals[key] = Reflect.get(window, key);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const testing = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { waitFor } = await import(testing.resolve('@testing-library/dom'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: reader, csrfToken: 'session-token' });
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let input = globalVisit;
  let address = globalAddress;
  const draw = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <LiteraryProfileSession id={literaryWorkId} locale="en" visit={input} address={address} />
        </QueryClientProvider>,
      ),
    );
  const inspection = () => host.querySelector<HTMLElement>('[data-literary-assertion-inspection]')!;
  const select = async (statement: string) => {
    const control = inspection().querySelector('select')!;
    await act(async () => {
      control.value = JSON.stringify(['schema:wordCount', statement]);
      control.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const inspect = async (detail = 1) => {
    const button = inspection().querySelector('button')!;
    await act(async () =>
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail })),
    );
    return button;
  };
  const until = (check: () => void) => act(async () => void (await waitFor(check)));
  try {
    await draw();
    await until(() => expect(host.querySelector('[data-literary-assertion-inspection] select')).not.toBeNull());
    expect(profileRequests.at(-1)).toEqual({
      id: literaryWorkId,
      type: 'schema:Book',
      context: candidateContext,
      expectedReader: reader,
    });
    const returnLink = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === m.literary_visit_return({}, { locale: 'en' as never }),
    )!;
    expect(returnLink.href).toBe(`https://site.test${sourceA}`);

    await select(duplicate.id);
    await inspect();
    await until(() => expect(inspection().querySelector('article')).not.toBeNull());
    expect(correctionRequests.at(-1)?.expectedReader).toBe(reader);
    const evidence = inspection().querySelector('article details') as HTMLDetailsElement;
    evidence.open = true;
    expect(evidence.querySelector('a[href="https://selected.example/work"]')).not.toBeNull();

    const keyboardRead = deferred<EditorRead>();
    nextRead = keyboardRead;
    const keyboardButton = inspection().querySelector('button')!;
    keyboardButton.focus();
    await act(async () =>
      keyboardButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })),
    );
    await keyboardRead.entered.promise;
    returnLink.focus();
    await act(async () => {
      keyboardRead.resolve(structuredClone(current));
      await keyboardRead.promise;
    });
    await until(() => expect(inspection().querySelector('article')).not.toBeNull());
    expect(window.document.activeElement).toBe(returnLink);

    const removed = structuredClone(current);
    removed.public.subject.statements['schema:wordCount'] = statements.filter((item) => item.id !== duplicate.id);
    freshAnswer = removed;
    await inspect();
    await until(() =>
      expect(inspection().textContent).toContain(m.literary_visit_currentness({}, { locale: 'en' as never })),
    );
    expect(inspection().querySelector('article')).toBeNull();
    expect(host.textContent).toContain('An original literary work');

    const lostDescriptor = structuredClone(current);
    delete lostDescriptor.release.properties['schema:wordCount'];
    freshAnswer = lostDescriptor;
    await inspect();
    await until(() =>
      expect(inspection().textContent).toContain(m.literary_visit_currentness({}, { locale: 'en' as never })),
    );
    expect(inspection().querySelector('article')).toBeNull();

    freshAnswer = {
      ...structuredClone(current),
      actions: { ...actions, subject: { state: 'available', actions: [] } },
    };
    await inspect();
    await until(() =>
      expect(inspection().textContent).toContain(m.literary_visit_currentness({}, { locale: 'en' as never })),
    );
    expect(inspection().querySelector('article')).toBeNull();

    freshAnswer = structuredClone(current);
    const late = deferred<EditorRead>();
    nextRead = late;
    await inspect();
    await late.entered.promise;
    input = realmVisit;
    address = realmAddress;
    await draw();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Global');
    input = globalVisit;
    address = globalAddress;
    const priorLoads = profileRequests.length;
    await draw();
    await until(() => expect(profileRequests.length).toBeGreaterThan(priorLoads));
    await until(() => expect(inspection().querySelector('select')).not.toBeNull());
    await act(async () => {
      late.resolve(structuredClone(current));
      await late.promise;
    });
    expect(inspection().querySelector('article')).toBeNull();

    input = globalVisit;
    address = globalAddress;
    await draw();
    await until(() => expect(inspection().querySelector('select')).not.toBeNull());
    const field = (property: string) => {
      const label = current.release.properties[property]!.labels.en;
      return [...host.querySelectorAll<HTMLElement>('section[aria-label]')].find(
        (item) => item.getAttribute('aria-label') === label,
      )!;
    };
    const wordCount = field('schema:wordCount');
    const sourcePicker = wordCount.querySelector<HTMLSelectElement>(
      `select[aria-label="${m.facts_choose_value({}, { locale: 'en' as never })}"]`,
    )!;
    await act(async () => {
      sourcePicker.value = first.id;
      sourcePicker.dispatchEvent(new window.Event('change', { bubbles: true }));
      [...wordCount.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.facts_edit_field({}, { locale: 'en' as never }))!
        .click();
    });
    await act(async () => {
      const amount = wordCount.querySelector<HTMLInputElement>(
        `input[aria-label="${m.correction_amount({}, { locale: 'en' as never })}"]`,
      )!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(amount, '+13000');
      amount.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.facts_review({}, { locale: 'en' as never }))!
        .click(),
    );
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.facts_submit({}, { locale: 'en' as never }))!
        .click(),
    );
    await until(() => {
      expect(proposalCalls).toHaveLength(1);
      expect(host.textContent).toContain(m.correction_proposed({}, { locale: 'en' as never }));
    });

    profileAnswer = { ok: false, reason: 'unavailable' };
    const correctionReload = () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === m.correction_reload({}, { locale: 'en' as never }),
      )!;
    const beforeFailedReadback = profileRequests.length;
    await act(async () => correctionReload().click());
    await until(() => expect(profileRequests.length).toBeGreaterThan(beforeFailedReadback));
    await until(() => expect(host.querySelector('[data-literary-assertion-inspection]')).toBeNull());
    profileAnswer = structuredClone(initialProfile);
    await act(async () => correctionReload().click());
    await until(() => expect(inspection().querySelector('select')).not.toBeNull());
    await until(() => expect(host.textContent).toContain(m.correction_proposed({}, { locale: 'en' as never })));
    expect(proposalCalls).toHaveLength(1);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SubjectPage
            page={publicPage('Fresh public title after return')}
            locale="en"
            messages={publicMessages}
            renderJsonLd={false}
          />
        </QueryClientProvider>,
      ),
    );
    expect(host.textContent).toContain('Fresh public title after return');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  let resolveEntered!: () => void;
  const entered = new Promise<void>((yes) => (resolveEntered = yes));
  return { promise, resolve, entered: { promise: entered, resolve: resolveEntered } };
}
