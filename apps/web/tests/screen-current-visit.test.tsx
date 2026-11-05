import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import * as start from '../.storybook/react-start';
import type { SubjectRead } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import type { ScreenCurrentVisit } from '../src/features/catalogue/screen-current-visit';
import type { Release } from '@rezics/definitions';
import definitions from '../src/kernel/recorded/definitions-release.json';

type CapturedServerFn = {
  validator?: (input: unknown) => unknown;
  handler?: (input: { data?: unknown }) => unknown;
};
const serverFns: CapturedServerFn[] = [];
let queryContexts: string[] = [];
let responseContext = '00000000-0000-4000-8000-000000000906';
let nativeSubject: SubjectRead;
const digest = definitions.digest;
const subjectId = '00000000-0000-4000-8000-000000000901';
const realmId = '00000000-0000-4000-8000-000000000902';
const contextId = '00000000-0000-4000-8000-000000000906';

const release = definitions.release as Release;
const fakeClient = {
  subjects: ({ id }: { id: string }) => ({
    get: async (options?: { query?: { context?: string }; fetch?: RequestInit }) => {
      queryContexts.push(options?.query?.context ?? 'missing-context');
      return {
        status: 200,
        data: {
          ...nativeSubject,
          subject: {
            ...nativeSubject.subject,
            id,
            context: responseContext,
            release: digest,
          },
        },
      };
    },
  }),
  definitions: {
    active: { get: async () => ({ status: 200, data: { digest, head: 1 } }) },
    releases: ({ digest: requested }: { digest: string }) => ({
      get: async () => ({ status: 200, data: { digest: requested, release } }),
    }),
  },
};

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({ ...start, setResponseHeader: () => {} }));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    const capture: CapturedServerFn = {};
    serverFns.push(capture);
    const chain = {
      validator(next: (input: unknown) => unknown) {
        capture.validator = next;
        return chain;
      },
      handler(next: (input: { data?: unknown }) => unknown) {
        capture.handler = next;
        return async (input: { data?: unknown } = {}) => {
          const data = capture.validator ? capture.validator(input.data) : input.data;
          return capture.handler!({ data });
        };
      },
    };
    return chain;
  },
}));
mock.module('../src/kernel/client', () => ({
  kernelClient: () => fakeClient,
  requestLocale: () => 'en',
  configuredKernelOrigin: () => 'https://kernel.test',
  hasKernelOrigin: () => true,
  acceptLanguage: () => 'en',
  preparePrivatePage: () => {},
}));

function reading(context = contextId): SubjectRead {
  return {
    subject: {
      id: subjectId,
      type: 'schema:Movie',
      context,
      release: digest,
      labels: { en: 'The observatory' },
      descriptions: {},
      aliases: {},
      statements: {},
      sourceRecords: [],
    },
    related: {},
    account: null,
    summary: null,
  } as unknown as SubjectRead;
}

async function browser() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.invalid/en/subjects/${subjectId}/the-observatory` });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLAnchorElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Text',
    'Document',
    'MutationObserver',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  return {
    host,
    root,
    window,
    m,
    cleanup: async () => {
      await act(async () => root.unmount());
      window.close();
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Screen correction visits preserve the selected reading, exact occurrence and verified native Context', async () => {
  const [{ ScreenProfileEntry }, { ScreenProfileReader }, visitContract, subjectHref] = await Promise.all([
    import('../src/features/catalogue/screen-profile-entry'),
    import('../src/features/catalogue/screen-profile-reader'),
    import('../src/features/catalogue/screen-current-visit'),
    import('../src/subject/subject-href'),
  ]);
  const { screenCurrentRouteVisit, screenCurrentReturnHref, screenCurrentReturnValue, screenCurrentInspectionId } =
    visitContract;
  const source = `/en/subjects/${subjectId}/the-observatory?realm=${realmId}`;
  const visit: ScreenCurrentVisit = {
    version: 1,
    subject: subjectId,
    type: 'schema:Movie',
    context: contextId,
    realm: realmId,
    locale: 'en',
    definition: digest,
    source,
  };

  nativeSubject = reading();
  queryContexts = [];
  responseContext = contextId;
  const actions = await import('../src/features/catalogue/screen-profile-actions');
  const loadValidator = serverFns.find((entry) =>
    entry.validator?.toString().includes('Invalid Screen profile address'),
  );
  expect(loadValidator?.validator?.({ id: subjectId, context: contextId })).toEqual({
    id: subjectId,
    context: contextId,
  });
  expect(() => loadValidator?.validator?.({ id: subjectId, context: 'wrong' })).toThrow();
  expect(loadValidator?.validator?.({ id: subjectId })).toEqual({ id: subjectId });
  const selectedRead = await actions.loadScreenProfile({ data: { id: subjectId, context: contextId } });
  expect(selectedRead).toMatchObject({ ok: true, public: { subject: { id: subjectId, context: contextId } } });
  responseContext = PAGE_GLOBAL_CONTEXT;
  const globalRead = await actions.loadScreenProfile({ data: { id: subjectId } });
  expect(globalRead).toMatchObject({ ok: true, public: { subject: { context: PAGE_GLOBAL_CONTEXT } } });
  expect(queryContexts).toEqual([contextId, PAGE_GLOBAL_CONTEXT]);
  responseContext = '00000000-0000-4000-8000-000000000999';
  const changedRead = await actions.loadScreenProfile({ data: { id: subjectId, context: contextId } });
  expect(changedRead).toEqual({ ok: false, reason: 'invalid' });
  expect(queryContexts.at(-1)).toBe(contextId);

  const ui = await browser();
  try {
    await act(async () =>
      ui.root.render(
        h(ScreenProfileEntry, {
          id: subjectId,
          label: 'The observatory',
          locale: 'en',
          context: contextId,
          realm: realmId,
          source,
          type: 'schema:Movie',
          definition: digest,
        }),
      ),
    );
    const entry = ui.host.querySelector('a');
    expect(entry).not.toBeNull();
    const correctionAddress = new URL(entry!.getAttribute('href')!, 'https://site.invalid');
    const admitted = screenCurrentRouteVisit(correctionAddress.search);
    expect(admitted.kind).toBe('current');
    if (admitted.kind !== 'current') throw new Error('Expected selected Screen visit');
    expect(admitted.visit).toMatchObject({ subject: subjectId, context: contextId, realm: realmId, source });
    expect(screenCurrentRouteVisit(correctionAddress.search, 'existing-classification-handoff').kind).toBe('invalid');
    const globalVisit = { ...admitted.visit, context: PAGE_GLOBAL_CONTEXT };
    const globalHref = visitContract.screenCurrentVisitHref(correctionAddress.pathname, globalVisit);
    expect(globalHref).toBeDefined();
    expect(
      screenCurrentRouteVisit(new URL(globalHref!, 'https://site.invalid').search, 'existing-classification-handoff')
        .kind,
    ).toBe('current');

    const fixtureModule = await import('../src/kernel/fake/catalogue-screen-profile');
    const fixture = fixtureModule.screenProfileFixture('partial', 'en', true);
    const publicRead = fixture.facts.date.publicRead;
    const property = 'schema:datePublished';
    const statements = publicRead.subject.statements[property]!;
    const first = structuredClone(statements[0]!);
    const duplicateId = '00000000-0000-4000-8000-000000000905';
    const duplicate = { ...structuredClone(first), id: duplicateId };
    publicRead.subject.id = subjectId;
    publicRead.subject.context = contextId;
    publicRead.subject.statements[property] = [first, duplicate];
    const currentVisit: ScreenCurrentVisit = {
      ...admitted.visit,
      occurrence: { holder: subjectId, property, statement: duplicateId },
    };
    const returnHref = screenCurrentReturnHref(currentVisit);
    expect(returnHref).toBeDefined();
    const returned = screenCurrentReturnValue(new URL(returnHref!, 'https://site.invalid').search);
    expect(returned.kind).toBe('current');
    if (returned.kind !== 'current') throw new Error('Expected bounded Screen return');
    expect(returned.visit).toMatchObject({
      subject: subjectId,
      context: contextId,
      realm: realmId,
      occurrence: currentVisit.occurrence,
    });
    const redirect = subjectHref.canonicalRedirect(
      `/en/subjects/${subjectId}/the-observatory/screen`,
      correctionAddress.search,
    );
    expect(redirect.href).toContain(correctionAddress.search);

    responseContext = contextId;
    await act(async () =>
      ui.root.render(
        h(ScreenProfileReader, {
          locale: 'en',
          public: publicRead,
          release,
          currentVisit,
          inspection: currentVisit.occurrence,
          returnHref,
          visitIdentity: 'mounted-screen-current-visit',
        }),
      ),
    );
    const inspectLinks = [...ui.host.querySelectorAll('a')].filter(
      (anchor) => anchor.textContent === ui.m.screen_visit_inspect(),
    );
    const exactStatements = inspectLinks.flatMap((anchor) => {
      const parsed = screenCurrentRouteVisit(new URL(anchor.getAttribute('href')!, 'https://site.invalid').search);
      return parsed.kind === 'current' && parsed.visit.occurrence?.property === property
        ? [parsed.visit.occurrence.statement]
        : [];
    });
    expect(exactStatements).toContain(first.id);
    expect(exactStatements).toContain(duplicateId);
    expect(ui.host.querySelector(`#${screenCurrentInspectionId(duplicateId)}`)).not.toBeNull();
    expect(ui.host.textContent).toContain(ui.m.screen_visit_return());

    const staleVisit = {
      ...currentVisit,
      occurrence: { holder: subjectId, property, statement: '00000000-0000-4000-8000-000000000999' },
    };
    await act(async () =>
      ui.root.render(
        h(ScreenProfileReader, {
          locale: 'en',
          public: publicRead,
          release,
          inspection: staleVisit.occurrence,
          visitIdentity: 'screen-current-visit-withheld-evidence',
          returnNotice: true,
        }),
      ),
    );
    expect(ui.host.textContent).toContain(ui.m.screen_visit_occurrence_missing());
    expect(ui.host.textContent).not.toContain('00000000-0000-4000-8000-000000000999');
  } finally {
    await ui.cleanup();
  }
});
