import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import recorded from '../src/kernel/recorded/definitions-release.json';
import type { ConsentAddress } from '../src/features/catalogue/statement-consent';
import type { ContributionAddress } from '../src/features/catalogue/contribution-lifecycle';
import type { RelationDraft, RelationRead, RelationTransport } from '../src/subject/relation-candidates';

// Authored UNRUN. One mounted campaign connects real editors, Session adapters, BFFs,
// prepareSession and native-shaped HTTP seams. Neither this source nor typing is native proof.
const original = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const replacement = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const csrf = 'AAAAAAAAAAAAAAAAAAAAAA';
let serverReader = original;
let accessToken = 'fixture';
let currentRequest: Request;
let nativeClient: ReturnType<typeof createKernelClient>;
let release: unknown = recorded.release;
const cacheHeaders: string[] = [];
const envelopes: { data: Record<string, unknown>; request: Request }[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
type Delivery = 'success' | 'failure' | 'throw';
type Gate = {
  matches: (data: Record<string, unknown>, raw: Record<string, unknown>) => boolean;
  entered: ReturnType<typeof deferred<void>>;
  delivery: ReturnType<typeof deferred<Delivery>>;
};
const allGates: Gate[] = [];
let gate: Gate | undefined;
let preparing: { entered: ReturnType<typeof deferred<void>>; resume: ReturnType<typeof deferred<void>> } | undefined;
function delay(matches: Gate['matches']) {
  gate = { matches, entered: deferred<void>(), delivery: deferred<Delivery>() };
  allGates.push(gate);
  return gate;
}
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => {
          const subject = serverReader;
          const token = accessToken;
          const held = preparing;
          if (held) {
            preparing = undefined;
            held.entered.resolve();
            await held.resume.promise;
          }
          return { status: 'active', subject, accessToken: token, csrfToken: csrf };
        },
      }),
    },
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => {
    if (name.toLowerCase() === 'cache-control') cacheHeaders.push(value);
  },
}));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: (options: { method: string }) => {
    let validate: ((value: unknown) => unknown) | undefined;
    const chain = {
      validator(next: typeof validate) {
        validate = next;
        return chain;
      },
      handler(handler: (input: { data: unknown }) => Promise<unknown>) {
        return async (input: { data?: unknown; headers?: HeadersInit } = {}) => {
          const data = validate ? validate(input.data) : input.data;
          const headers = new Headers(input.headers);
          headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          headers.set('origin', 'https://site.test');
          currentRequest = new Request('https://site.test/en/_server/catalogue', { method: options.method, headers });
          const request = currentRequest;
          const bound = !!data && typeof data === 'object' && 'expectedReader' in data;
          const held =
            bound && gate?.matches(data as Record<string, unknown>, input.data as Record<string, unknown>)
              ? gate
              : undefined;
          if (held) gate = undefined;
          if (bound) envelopes.push({ data: structuredClone(data) as Record<string, unknown>, request });
          const result = await handler({ data });
          if (!held) return result;
          held.entered.resolve();
          const delivery = await held.delivery.promise;
          if (delivery === 'throw') throw new Error('Late catalogue delivery failure');
          return delivery === 'failure' ? { ok: false, reason: 'unavailable', state: 'unavailable' } : result;
        };
      },
    };
    return chain;
  },
}));
mock.module('../src/kernel/client', () => ({ kernelClient: () => nativeClient, requestLocale: () => 'en' }));
mock.module('../src/subject/definitions', () => ({
  readRelease: async () => release,
  refreshRelease: async () => release,
}));

const { catalogueTermsFixture, termsSubjectId } = await import('../src/kernel/fake/catalogue-terms');
const { relationFixture } = await import('../src/kernel/fake/catalogue-relations');
const { workPartsFixture } = await import('../src/kernel/fake/work-parts');
const { consentFixture } = await import('../src/kernel/fake/statement-consent');
const { contributionFixture } = await import('../src/kernel/fake/contribution-lifecycle');
const { editorialContextFixture } = await import('../src/kernel/fake/editorial-context');
const { candidateSession, useCatalogueLifetime } = await import('../src/subject/candidate-lifetime');
const { editorRequest } = await import('../src/features/catalogue/editor-request');
const { SubjectTermsSession } = await import('../src/features/catalogue/subject-terms-session');
const { RelationEditorSession } = await import('../src/features/catalogue/relation-editor-session');
const { WorkPartsSession } = await import('../src/features/catalogue/work-parts-session');
const { RelationEditor } = await import('../src/features/catalogue/relation-editor');
const { StatementConsentPage } = await import('../src/features/catalogue/statement-consent-view');
const { ContributionLifecycle } = await import('../src/features/catalogue/contribution-lifecycle-view');
const { EditorialContextWorkspace } = await import('../src/features/catalogue/editorial-context-view');
const { loadCatalogueTerms, saveCatalogueTerms } = await import('../src/features/catalogue/subject-terms-actions');
const { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } =
  await import('../src/features/catalogue/relation-editor-actions');
const { readSubjectWorkParts } = await import('../src/features/catalogue/work-parts-actions');
const { readConsent, changeConsent, refreshConsentPublic } =
  await import('../src/features/catalogue/statement-consent-actions');
const { changeOwnContribution, rereadOwnContribution } =
  await import('../src/features/catalogue/contribution-lifecycle-actions');
const { changeEditorialWorkspace, readEditorialWorkspace } =
  await import('../src/features/catalogue/editorial-context-actions');
const { submitCorrection } = await import('../src/features/catalogue/statement-editor-actions');
const { submitFactCorrection } = await import('../src/features/catalogue/subject-facts-actions');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const signedIn = (subject = original, csrfToken = csrf) => ({ state: 'signed-in' as const, subject, csrfToken });
const headers = { 'X-CSRF-Token': csrf };
let selected = 0;
let cleared = 0;

// These two thin adapters use the production BFFs and the same original-reader plumbing
// as the route/profile callers. No replacement command or fake success is manufactured.
const Consent = candidateSession(function Consent({ address, locale }: { address: ConsentAddress; locale: string }) {
  const work = useCatalogueLifetime('consent');
  return createElement(StatementConsentPage, {
    address,
    locale,
    transport: {
      read: (cursor, session) => readConsent({ data: editorRequest({ ...address, cursor, session }, work), headers }),
      change: (command) => changeConsent({ data: editorRequest(command, work), headers }),
      public: (session, terminal) =>
        refreshConsentPublic({ data: editorRequest({ ...address, session, terminal }, work), headers }),
    },
  });
});
const Lifecycle = candidateSession(function Lifecycle({
  address,
  locale,
}: {
  address: ContributionAddress;
  locale: string;
}) {
  const work = useCatalogueLifetime('lifecycle');
  return createElement(ContributionLifecycle, {
    address,
    locale,
    onClear: () => {
      cleared++;
    },
    transport: {
      change: (command) => changeOwnContribution({ data: editorRequest(command, work), headers }),
      read: (address) => rereadOwnContribution({ data: editorRequest(address, work), headers }),
    },
  });
});
const Editorial = candidateSession(function Editorial({ id, locale }: { id?: string; locale: string }) {
  const work = useCatalogueLifetime('editorial');
  return createElement(EditorialContextWorkspace, {
    id,
    locale,
    transport: {
      read: (address) => readEditorialWorkspace({ data: editorRequest(address, work), headers }),
      submit: (command) => changeEditorialWorkspace({ data: editorRequest(command, work), headers }),
    },
  });
});
const ComposedRelation = candidateSession(function ComposedRelation({
  fixture,
  locale,
  statement = fixture.draft,
  read,
}: {
  fixture: ReturnType<typeof relationFixture>;
  locale: string;
  statement?: RelationDraft;
  read?: RelationTransport['read'];
}) {
  const work = useCatalogueLifetime('relation');
  return createElement(RelationEditor, {
    id: fixture.id,
    locale,
    composition: { statement, slot: fixture.slot, positionEditable: false },
    search: async () => [],
    onSelected: () => {
      selected++;
    },
    transport: {
      read:
        read ??
        ((slot, cursor, session) =>
          readSubjectRelationEditor({ data: editorRequest({ id: fixture.id, slot, cursor, session }, work), headers })),
      propose: (command) => proposeSubjectRelation({ data: editorRequest(command, work), headers }),
      confirm: (command) => confirmSubjectRelation({ data: editorRequest(command, work), headers }),
    },
  });
});

async function mounted() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedIn());
  let changeContent!: (node: ReactNode) => void;
  function Surface() {
    const [content, setContent] = useState<ReactNode>(null);
    changeContent = (node) => setContent(() => node);
    return content;
  }
  const route = createRootRoute({ component: Surface });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
  });
  const render = async (node: ReactNode) => {
    await act(async () => changeContent(node));
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const until = async (predicate: () => boolean) => {
    for (let count = 0; count < 100 && !predicate(); count++) await settle();
    expect(predicate()).toBe(true);
  };
  const buttons = (label: string) =>
    [...window.document.body.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
  const button = (label: string) => {
    const found = buttons(label);
    expect(found.length).toBeGreaterThan(0);
    return found[found.length - 1]!;
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };
  const field = async (property: string) => {
    await act(async () => {
      const select = host.querySelector('#candidate-field')! as InstanceType<typeof window.HTMLSelectElement>;
      expect(select).not.toBeNull();
      select.value = property;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const update = async (
    observed: ReturnType<typeof signedIn> | { state: 'signed-out' | 'unavailable'; subject: null; csrfToken: null },
  ) => {
    if (observed.subject) serverReader = observed.subject;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, observed);
    });
    await settle();
  };
  const queued = (element: object) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!;
    const props = Reflect.get(element, key) as Record<string, (event: unknown) => unknown>;
    return (name = 'onClick') => props[name]!({ currentTarget: element, preventDefault() {} });
  };
  const outside = window.document.createElement('button');
  outside.textContent = 'Fresh reader focus';
  window.document.body.append(outside);
  return {
    window,
    host,
    client,
    render,
    settle,
    until,
    button,
    buttons,
    click,
    field,
    update,
    queued,
    outside,
    async close() {
      await act(async () => root.unmount());
      client.clear();
      window.close();
      for (const [key, descriptor] of previous)
        descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    },
  };
}

// Exactly one connected mounted regression; intentionally not executed by this source task.
test('catalogue editors retain only their original live reader, exact address and frozen native command', async () => {
  const ui = await mounted();
  const activate = async (fixture: { client: typeof nativeClient; release?: unknown }, token = 'fixture') => {
    await ui.render(null);
    nativeClient = fixture.client;
    release = fixture.release ?? recorded.release;
    accessToken = token;
    serverReader = original;
    await ui.update(signedIn());
  };
  const deliver = async (held: Gate, result: Delivery) => {
    await act(async () => held.delivery.resolve(result));
    await ui.settle();
  };
  const input = async (selector: string, value: string) => {
    await act(async () => {
      const element = ui.host.querySelector(selector)! as HTMLInputElement;
      expect(element).not.toBeNull();
      const prototype =
        element.tagName === 'SELECT' ? ui.window.HTMLSelectElement.prototype : ui.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new ui.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  const termsControl = (part: 'labels' | 'labels-mode') => {
    const fieldset = [...ui.host.querySelectorAll('fieldset')].find(
      (element) => element.querySelector('legend')?.textContent === m.catalogue_create_label(),
    );
    const label = [...(fieldset?.querySelectorAll('label') ?? [])].find(
      (element) =>
        element.textContent === (part === 'labels-mode' ? m.catalogue_terms_action() : m.catalogue_create_label()),
    );
    return ui.window.document.getElementById(label?.htmlFor ?? '');
  };
  const termsSelector = (part: 'labels' | 'labels-mode') => `[id="${termsControl(part)!.id}"]`;
  const submitTerms = async () => {
    const submit = ui.queued(ui.host.querySelector('form')!);
    await act(async () => {
      void submit('onSubmit');
    });
  };
  const terms = async (fixture: ReturnType<typeof catalogueTermsFixture>, title = 'Private original draft') => {
    await ui.render(createElement(SubjectTermsSession, { id: termsSubjectId, locale: 'en' }));
    await ui.until(() => !!termsControl('labels-mode'));
    await input(termsSelector('labels-mode'), 'set');
    await input(termsSelector('labels'), title);
  };
  const relation = async (fixture: ReturnType<typeof relationFixture>, read?: RelationTransport['read']) => {
    await ui.render(createElement(ComposedRelation, { fixture, locale: 'en', read }));
    await ui.click(m.relation_open());
    await ui.until(() => ui.buttons(m.relation_propose()).length > 0);
  };
  const propose = async () => {
    await ui.click(m.relation_propose());
    await ui.click(m.relation_propose());
  };
  const prepareAdoption = async () => {
    await ui.click(m.relation_review_slot());
    await ui.until(() => ui.buttons(m.candidate_review()).length > 0);
    await ui.click(m.candidate_review());
    await ui.until(() => ui.buttons(m.candidate_accept()).length > 0);
    await ui.click(m.candidate_accept());
    await ui.click(m.candidate_accept());
    await ui.until(() => ui.host.textContent!.includes(m.candidate_accepted()));
    await ui.click(m.candidate_reload());
    await ui.until(() => ui.buttons(m.candidate_review()).length > 0);
    await ui.click(m.candidate_review());
    await ui.until(() => ui.buttons(m.candidate_adopt()).length > 0);
    await ui.click(m.candidate_adopt());
  };
  const consent = async (fixture: ReturnType<typeof consentFixture>) => {
    await ui.render(createElement(Consent, { address: fixture.address, locale: 'en' }));
    await ui.click(m.statement_consent_open());
    await ui.until(() => ui.buttons(m.statement_consent_share()).length > 0);
  };
  const consentConfirmation = async () => {
    await ui.click(m.statement_consent_share());
    await act(async () => {
      (ui.host.querySelector('[role="checkbox"]') as HTMLElement).click();
    });
  };
  const withdraw = async () => {
    await ui.click(m.contribution_withdraw());
    await ui.click(m.contribution_confirm());
  };
  const noContinuity = (start: number) => {
    for (const { data } of envelopes.slice(start)) {
      expect(data.session).toBeUndefined();
      expect(data.expectedReader).toBe(replacement);
    }
  };
  try {
    // Every family refuses a mismatched prepared request before any native I/O.
    const key = '00000000-0000-4000-8000-000000000999';
    const tf = catalogueTermsFixture();
    await activate(tf);
    serverReader = replacement;
    expect(await loadCatalogueTerms({ data: { id: termsSubjectId, expectedReader: original } })).toEqual({
      state: 'denied',
    });
    expect(
      await saveCatalogueTerms({
        data: { id: termsSubjectId, expectedReader: original, key, etag: '"7"', patch: { labels: { en: 'Refused' } } },
        headers,
      }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(tf.calls).toHaveLength(0);
    const rf = relationFixture();
    nativeClient = rf.client;
    release = rf.release;
    expect(
      await readSubjectRelationEditor({ data: { id: rf.id, slot: rf.slot, expectedReader: original }, headers }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(
      await proposeSubjectRelation({
        data: { id: rf.id, slot: rf.slot, statement: rf.draft, key, expectedReader: original },
        headers,
      }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(
      await confirmSubjectRelation({
        data: {
          id: rf.id,
          slot: rf.slot,
          candidate: rf.candidate.id,
          operation: 'adopt',
          head: 3,
          rank: 'normal',
          key,
          expectedReader: original,
        },
        headers,
      }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(
      await submitCorrection({ data: { id: rf.id, statement: rf.draft, key, expectedReader: original }, headers }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(
      await submitFactCorrection({ data: { id: rf.id, statement: rf.draft, key, expectedReader: original }, headers }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(rf.calls).toHaveLength(0);
    const wf = workPartsFixture();
    nativeClient = wf.client;
    expect(await readSubjectWorkParts({ data: { id: wf.id, expectedReader: original }, headers })).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(wf.calls).toHaveLength(0);
    const cf = consentFixture();
    nativeClient = cf.client;
    expect(await readConsent({ data: { ...cf.address, expectedReader: original }, headers })).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(
      await changeConsent({ data: { ...cf.address, operation: 'disclose', key, expectedReader: original }, headers }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(await refreshConsentPublic({ data: { ...cf.address, expectedReader: original }, headers })).toEqual({
      state: 'denied',
    });
    expect(cf.calls).toHaveLength(0);
    const lf = contributionFixture();
    nativeClient = lf.client;
    expect(
      await changeOwnContribution({
        data: { ...lf.address, operation: 'delete', key, expectedReader: original },
        headers,
      }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(await rereadOwnContribution({ data: { ...lf.address, expectedReader: original }, headers })).toEqual({
      subject: 'unavailable',
      candidate: 'unconfirmed',
      selected: null,
    });
    expect(lf.calls).toHaveLength(0);

    const ef = editorialContextFixture();
    nativeClient = ef.client;
    expect(await readEditorialWorkspace({ data: { id: ef.id, expectedReader: original }, headers })).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(
      await changeEditorialWorkspace({
        data: { operation: 'delete', id: ef.id, key, expectedReader: original },
        headers,
      }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(ef.calls).toHaveLength(0);

    // The reader guard and authorization come from ONE prepared Request. Changing the
    // backing session while that preparation is in flight cannot splice a second credential.
    await activate(tf);
    accessToken = 'prepared-original';
    const preparation = { entered: deferred<void>(), resume: deferred<void>() };
    preparing = preparation;
    const preparedRead = loadCatalogueTerms({ data: { id: termsSubjectId, expectedReader: original } });
    await preparation.entered.promise;
    serverReader = replacement;
    accessToken = 'replacement-token';
    preparation.resume.resolve();
    expect((await preparedRead).state).toBe('ready');
    expect(tf.calls.every((call) => call.authorization === 'Bearer prepared-original')).toBe(true);
    const beforeMismatch = tf.calls.length;
    expect((await loadCatalogueTerms({ data: { id: termsSubjectId, expectedReader: original } })).state).toBe('denied');
    expect(tf.calls).toHaveLength(beforeMismatch);

    serverReader = original;
    const mismatchPreparation = { entered: deferred<void>(), resume: deferred<void>() };
    preparing = mismatchPreparation;
    const refusedPrepared = loadCatalogueTerms({ data: { id: termsSubjectId, expectedReader: replacement } });
    await mismatchPreparation.entered.promise;
    serverReader = replacement;
    mismatchPreparation.resume.resolve();
    expect((await refusedPrepared).state).toBe('denied');
    expect(tf.calls).toHaveLength(beforeMismatch);

    // Public terms and evidence remain anonymous even with a signed-in request cookie.
    expect((await loadCatalogueTerms({ data: { id: termsSubjectId, expectedReader: null } })).state).toBe('ready');
    expect(tf.calls.at(-1)!.authorization).toBeNull();
    nativeClient = cf.client;
    expect((await refreshConsentPublic({ data: { ...cf.address, expectedReader: null }, headers })).state).toBe(
      'absent',
    );
    expect(cf.calls.at(-1)!.authorization).toBeNull();
    const publicCount = cf.calls.length;
    expect(
      (
        await refreshConsentPublic({
          data: { ...cf.address, expectedReader: null, session: 'private-old-token' },
          headers,
        })
      ).state,
    ).toBe('denied');
    expect(cf.calls).toHaveLength(publicCount);

    // A healthy rerender preserves an editable draft. A lost response freezes its exact
    // key, ETag, native body and continuity; the live retry replays all of them unchanged.
    const uncertainTerms = catalogueTermsFixture('uncertain');
    await activate(uncertainTerms);
    await terms(uncertainTerms);
    await ui.render(createElement(SubjectTermsSession, { id: termsSubjectId, locale: 'en' }));
    expect((termsControl('labels') as HTMLInputElement).value).toBe('Private original draft');
    await submitTerms();
    await ui.until(() => ui.buttons(m.catalogue_create_retry()).length > 0);
    const frozenSubmit = ui.queued(ui.host.querySelector('form')!);
    const firstPatch = structuredClone(uncertainTerms.calls.find((call) => call.method === 'PATCH')!);
    expect(firstPatch.body).toEqual({ labels: { en: 'Private original draft' } });
    expect(firstPatch.etag).toBe('"7"');
    expect(firstPatch.session).toBe('terms-read');
    await submitTerms();
    await ui.until(() => ui.host.textContent!.includes(m.catalogue_terms_saved()));
    const patches = uncertainTerms.calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual(firstPatch);

    // Queued callback before effects + batched A-B-A cannot revive the original admission.
    const beforeABA = uncertainTerms.calls.length;
    await act(async () => {
      ui.client.setQueryData(sessionQuery.queryKey, signedIn(replacement));
      ui.client.setQueryData(sessionQuery.queryKey, signedIn());
      void frozenSubmit('onSubmit');
    });
    await ui.settle();
    expect(uncertainTerms.calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(ui.host.textContent).not.toContain(m.catalogue_terms_saved());
    expect(ui.buttons(m.catalogue_create_retry())).toHaveLength(0);
    expect(uncertainTerms.calls.slice(beforeABA).every((call) => call.session === null)).toBe(true);

    // Retire reads and writes on every transition and deliver success/failure/throw late.
    // A replacement may start its own fresh public read; it must never inherit the old
    // private payload, uncertain command, native continuity, busy/finally or comparison.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      for (const transition of ['reader', 'sign-out', 'admission', 'target', 'locale', 'unmount'] as const) {
        const fixture = catalogueTermsFixture();
        await activate(fixture);
        await terms(fixture);
        const held = delay((data) => 'patch' in data);
        await submitTerms();
        await held.entered.promise;
        const old = ui.queued(ui.host.querySelector('form')!);
        if (transition === 'reader') await ui.update(signedIn(replacement));
        if (transition === 'sign-out') await ui.update({ state: 'signed-out', subject: null, csrfToken: null });
        if (transition === 'admission') await ui.update(signedIn(original, 'BBBBBBBBBBBBBBBBBBBBBB'));
        if (transition === 'target')
          await ui.render(createElement(SubjectTermsSession, { id: replacement, locale: 'en' }));
        if (transition === 'locale')
          await ui.render(createElement(SubjectTermsSession, { id: termsSubjectId, locale: 'ja' }));
        if (transition === 'unmount') await ui.render(null);
        await ui.settle();
        const count = fixture.calls.length;
        const requests = envelopes.length;
        await act(async () => {
          void old('onSubmit');
        });
        ui.outside.focus();
        await deliver(held, delivery);
        expect(fixture.calls).toHaveLength(count);
        expect(envelopes).toHaveLength(requests);
        expect(fixture.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
        expect(ui.buttons(m.catalogue_create_retry())).toHaveLength(0);
        expect(ui.host.textContent).not.toContain(m.catalogue_terms_saved());
        expect(ui.window.document.activeElement).toBe(ui.outside);
        await ui.update(signedIn());
        expect(ui.buttons(m.catalogue_create_retry())).toHaveLength(0);
      }
      const fixture = catalogueTermsFixture();
      await activate(fixture);
      const held = delay((data) => data.id === termsSubjectId && !('patch' in data));
      await ui.render(createElement(SubjectTermsSession, { id: termsSubjectId, locale: 'en' }));
      await held.entered.promise;
      await ui.update(signedIn(replacement));
      await ui.until(() => !!termsControl('labels-mode'));
      const count = fixture.calls.length;
      await deliver(held, delivery);
      expect(fixture.calls).toHaveLength(count);
      // Retired pending query never deposits a private payload in the cache.
      expect(
        ui.client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[0] === 'catalogue-terms' && query.getObserversCount() === 0)
          .every((query) => query.state.data === undefined),
      ).toBe(true);
    }

    const retiredUncertain = catalogueTermsFixture('uncertain');
    await activate(retiredUncertain);
    await terms(retiredUncertain, 'Lost original command');
    await submitTerms();
    await ui.until(() => ui.buttons(m.catalogue_create_retry()).length > 0);
    const retiredRetry = ui.queued(ui.host.querySelector('form')!);
    await ui.update(signedIn(replacement));
    await ui.until(() => !!termsControl('labels-mode'));
    const retiredCount = retiredUncertain.calls.length;
    await act(async () => {
      void retiredRetry('onSubmit');
    });
    expect(retiredUncertain.calls).toHaveLength(retiredCount);
    expect(ui.buttons(m.catalogue_create_retry())).toHaveLength(0);
    expect((termsControl('labels-mode') as HTMLSelectElement).value).toBe('keep');
    await ui.update(signedIn());
    expect(ui.buttons(m.catalogue_create_retry())).toHaveLength(0);

    // Stale ETag requires an explicit current read/comparison and a new confirmed reapply.
    const staleTerms = catalogueTermsFixture('stale');
    await activate(staleTerms);
    await terms(staleTerms, 'Explicit reapply');
    await submitTerms();
    await ui.until(() => ui.host.textContent!.includes(m.catalogue_terms_stale()));
    const staleWrites = staleTerms.calls.filter((call) => call.method === 'PATCH');
    expect(staleWrites).toHaveLength(1);
    await ui.click(m.catalogue_terms_compare());
    await ui.until(() => ui.buttons(m.catalogue_terms_confirm()).length > 0);
    expect(staleTerms.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    const overlap = [...ui.host.querySelectorAll('fieldset')].find(
      (element) => element.querySelector('legend')?.textContent === `en: ${m.catalogue_create_label()}`,
    );
    const choice = [...(overlap?.querySelectorAll('label') ?? [])].find(
      (element) => element.textContent === m.catalogue_terms_resolve_choice(),
    );
    await input(`[id="${choice?.htmlFor}"]`, 'draft');
    await ui.click(m.catalogue_terms_review());
    await submitTerms();
    await ui.until(() => ui.host.textContent!.includes(m.catalogue_terms_saved()));
    const reapplied = staleTerms.calls.filter((call) => call.method === 'PATCH')[1]!;
    expect(reapplied.etag).toBe('"8"');
    expect(reapplied.key).not.toBe(staleWrites[0]!.key);
    expect(reapplied.body).toEqual(staleWrites[0]!.body);

    // Public signed-out mount still reads; fresh signed-in admission can write afterward.
    const publicTerms = catalogueTermsFixture();
    await activate(publicTerms);
    await ui.update({ state: 'signed-out', subject: null, csrfToken: null });
    await ui.render(createElement(SubjectTermsSession, { id: termsSubjectId, locale: 'en' }));
    await ui.until(() => ui.host.textContent!.includes('Original film'));
    expect(publicTerms.calls.every((call) => call.authorization === null)).toBe(true);
    await ui.update(signedIn(replacement));
    await ui.until(() => !!termsControl('labels-mode'));
    await input(termsSelector('labels-mode'), 'set');
    await input(termsSelector('labels'), 'Fresh reader title');
    await submitTerms();
    await ui.until(() => ui.host.textContent!.includes(m.catalogue_terms_saved()));
    expect(publicTerms.calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      labels: { en: 'Fresh reader title' },
    });

    // Real standalone Session read remains usable, including a replacement reader.
    const standalone = relationFixture();
    await activate(standalone);
    await ui.render(createElement(RelationEditorSession, { id: standalone.id, locale: 'en' }));
    await ui.click(m.relation_open());
    await ui.until(() => {
      const region = ui.host.querySelector(`section[aria-label="${m.relation_title()}"]`);
      const label = [...(region?.querySelectorAll('label') ?? [])].find(
        (node) => node.textContent === m.relation_property(),
      );
      const control = ui.window.document.getElementById(label?.htmlFor ?? '');
      return !!label && !!control && control.tagName === 'SELECT' && !!region?.contains(control);
    });
    await ui.update(signedIn(replacement));
    await ui.click(m.relation_open());
    await ui.until(() => {
      const region = ui.host.querySelector(`section[aria-label="${m.relation_title()}"]`);
      const label = [...(region?.querySelectorAll('label') ?? [])].find(
        (node) => node.textContent === m.relation_property(),
      );
      const control = ui.window.document.getElementById(label?.htmlFor ?? '');
      return !!label && !!control && control.tagName === 'SELECT' && !!region?.contains(control);
    });
    expect(standalone.calls.some((call) => call.path.endsWith(standalone.id))).toBe(true);

    // Continuation, exact retry and sparse result focus; a retired continuation stays silent.
    const continued = relationFixture();
    const pageReads: { slot?: unknown; cursor?: string; session?: string }[] = [];
    const pendingPage = deferred<RelationRead>();
    const pageStarted = deferred<void>();
    let failSparseRead = true;
    const continuationRead: RelationTransport['read'] = async (slot, cursor, session) => {
      pageReads.push({ slot, cursor, session });
      const result = await continued.transport.read(slot, cursor, session);
      if (!result.ok || !slot) return result;
      if (!cursor) return { ...result, page: { ...result.page!, next: 'middle' } };
      if (cursor === 'middle') return { ...result, page: { ...result.page!, next: 'sparse' } };
      if (cursor === 'sparse' && failSparseRead) {
        failSparseRead = false;
        return { ok: false, reason: 'unavailable' };
      }
      if (cursor === 'sparse') return { ...result, page: { ...result.page!, candidates: [], next: 'retired' } };
      pageStarted.resolve();
      return pendingPage.promise;
    };
    await activate(continued);
    await relation(continued, continuationRead);
    ui.outside.focus();
    await ui.click(m.relation_review_slot());
    await ui.until(() => ui.buttons(m.candidate_more()).length > 0);
    const pageBoundary = () => ui.host.querySelector(`section[aria-label="${m.relation_review_slot()}"]`);
    expect(ui.window.document.activeElement).not.toBe(pageBoundary());
    await ui.click(m.candidate_more());
    await ui.until(() => !!pageBoundary() && ui.buttons(m.candidate_more()).length > 0);
    expect(ui.window.document.activeElement).toBe(pageBoundary());
    await ui.click(m.candidate_more());
    await ui.until(() => !!ui.host.querySelector('[role="alert"]'));
    expect(ui.window.document.activeElement).toBe(ui.host.querySelector('[role="alert"]'));
    await ui.click(m.statement_consent_retry_page());
    await ui.until(() => ui.host.querySelector('[role="status"]')?.textContent === m.candidate_empty());
    expect(pageReads.slice(-2)).toEqual([
      { slot: continued.slot, cursor: 'sparse', session: 'relation-session' },
      { slot: continued.slot, cursor: 'sparse', session: 'relation-session' },
    ]);
    expect(ui.window.document.activeElement).toBe(ui.host.querySelector('[role="status"]'));
    expect(ui.buttons(m.candidate_more())).toHaveLength(1);
    await ui.click(m.candidate_more());
    await pageStarted.promise;
    await ui.update(signedIn(replacement));
    ui.outside.focus();
    pendingPage.resolve(await continued.transport.read(continued.slot, 'retired', 'relation-session'));
    await ui.settle();
    expect(ui.window.document.activeElement).toBe(ui.outside);
    expect(pageBoundary()).toBeNull();

    // The replacement starts its own live proposal, exact review and native adoption.
    const freshRelation = relationFixture();
    await activate(freshRelation);
    await ui.update(signedIn(replacement));
    const freshStart = envelopes.length;
    await relation(freshRelation);
    ui.outside.focus();
    await propose();
    await ui.until(() => ui.host.textContent!.includes(m.relation_proposed()));
    expect(ui.window.document.activeElement).not.toBe(
      ui.host.querySelector(`section[aria-label="${m.relation_review_slot()}"]`),
    );
    const freshProposal = freshRelation.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/candidates'),
    )!;
    expect(freshProposal.body).toMatchObject({
      statement: { property: { id: freshRelation.slot.property }, value: freshRelation.draft.value },
    });
    expect(freshProposal.body).not.toHaveProperty('expectedReader');
    const selectedBeforeFresh = selected;
    await prepareAdoption();
    await ui.click(m.candidate_adopt());
    await ui.until(() => selected === selectedBeforeFresh + 1);
    expect(freshRelation.adopted).toBe(true);
    expect(envelopes.slice(freshStart).every(({ data }) => data.expectedReader === replacement)).toBe(true);
    expect(freshRelation.calls.find((call) => call.path.endsWith(':adopt'))!.body).toMatchObject({
      property: freshRelation.slot.property,
      target: freshRelation.slot.target,
      key: freshRelation.slot.key,
      expected_head: 7,
      selection: [{ candidate: freshRelation.candidates.at(-1)!.id, rank: 'normal' }],
    });

    // Retired proposal delivery cannot start its second read or mutate selection.
    // A retired secondary-read delivery cannot populate private review or unlock finally.
    for (const stage of ['read', 'propose', 'secondary', 'confirm'] as const) {
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        const fixture = relationFixture();
        await activate(fixture);
        let held: Gate;
        if (stage === 'read') {
          held = delay((data) => 'slot' in data && !('statement' in data) && !('operation' in data));
          await ui.render(createElement(ComposedRelation, { fixture, locale: 'en' }));
          await ui.click(m.relation_open());
        } else {
          await relation(fixture);
          if (stage === 'propose') held = delay((data) => 'statement' in data);
          else if (stage === 'secondary')
            held = delay((data) => 'slot' in data && !('statement' in data) && !('operation' in data));
          else {
            await prepareAdoption();
            held = delay((data) => data.operation === 'adopt');
            await ui.click(m.candidate_adopt());
          }
          if (stage !== 'confirm') await propose();
        }
        await held!.entered.promise;
        const callbacks = [...ui.host.querySelectorAll('button')].map((button) => ui.queued(button));
        const selectedBefore = selected;
        const start = envelopes.length;
        await ui.update(signedIn(replacement));
        // The replacement explicitly opens its own read, with no old native continuity.
        await ui.click(m.relation_open());
        await ui.until(() => ui.buttons(m.relation_propose()).length > 0);
        noContinuity(start);
        const count = fixture.calls.length;
        const requests = envelopes.length;
        await act(async () => {
          for (const old of callbacks) void old();
        });
        ui.outside.focus();
        await deliver(held!, delivery);
        expect(fixture.calls).toHaveLength(count);
        expect(envelopes).toHaveLength(requests);
        expect(selected).toBe(selectedBefore);
        expect(ui.window.document.activeElement).toBe(ui.outside);
        expect(ui.host.textContent).not.toContain(m.relation_proposed());
        await ui.update(signedIn());
        expect(ui.host.textContent).not.toContain(m.relation_proposed());
      }
    }

    // Exact slot changes retire queued proposal controls, even if subject and reader stay.
    const slotFixture = relationFixture();
    await activate(slotFixture);
    await relation(slotFixture);
    await ui.click(m.relation_propose());
    const oldSlotConfirm = ui.queued(ui.button(m.relation_propose()));
    const different = structuredClone(slotFixture.draft);
    different.value = { type: 'value', content: replacement };
    await ui.render(createElement(ComposedRelation, { fixture: slotFixture, locale: 'en', statement: different }));
    const slotCount = slotFixture.calls.length;
    await act(async () => {
      void oldSlotConfirm();
    });
    expect(slotFixture.calls).toHaveLength(slotCount);
    expect(ui.buttons(m.candidate_cancel())).toHaveLength(0);

    // A live uncertain adoption reuses native head, rank, exact slot, body and key.
    const uncertainRelation = relationFixture('lost-response');
    await activate(uncertainRelation);
    await relation(uncertainRelation);
    await prepareAdoption();
    await ui.click(m.candidate_adopt());
    await ui.until(() => ui.host.textContent!.includes(m.candidate_unavailable()));
    const adoption = structuredClone(uncertainRelation.calls.find((call) => call.path.endsWith(':adopt'))!);
    expect(adoption.body).toMatchObject({
      property: uncertainRelation.slot.property,
      target: uncertainRelation.slot.target,
      expected_head: expect.any(Number),
      selection: [{ candidate: uncertainRelation.candidate.id, rank: 'normal' }],
    });
    expect(adoption.body).not.toHaveProperty('expectedReader');
    await ui.click(m.candidate_adopt());
    await ui.until(() => uncertainRelation.calls.filter((call) => call.path.endsWith(':adopt')).length === 2);
    expect(uncertainRelation.calls.filter((call) => call.path.endsWith(':adopt'))[1]).toEqual(adoption);
    expect(uncertainRelation.adopted).toBe(true);

    // Work Parts uses its real Session, native holder and independent embedded corrections.
    // Opening a second off-page correction cannot destroy the first correction's draft.
    const parts = workPartsFixture('partial');
    await activate(parts);
    await ui.render(createElement(WorkPartsSession, { id: parts.id, locale: 'en' }));
    await ui.until(() => ui.buttons(m.work_parts_correct()).length > 0);
    await ui.click(m.work_parts_correct());
    await ui.click(m.relation_open());
    await ui.until(() => ui.buttons(m.relation_propose()).length > 0);
    const positionSelector = 'input[id$="qualifier-0"]';
    await input(positionSelector, '3');
    const firstCorrection = ui.host.querySelector(positionSelector)!;
    await ui.click(m.work_parts_more());
    await ui.until(() => ui.host.textContent!.includes('Volume Ten'));
    await ui.click(m.work_parts_correct());
    expect(ui.host.contains(firstCorrection)).toBe(true);
    expect((firstCorrection as HTMLInputElement).value).toBe('3');
    // First correction stays independently live and sends the native holder, never anchor.
    await propose();
    await ui.until(() => parts.calls.some((call) => call.method === 'POST' && call.path.endsWith('/candidates')));
    const partProposal = parts.calls.find((call) => call.method === 'POST' && call.path.endsWith('/candidates'))!;
    expect(partProposal.path).toContain(parts.holder.subject.id);
    expect(partProposal.path).not.toContain(`/subjects/${parts.id}/candidates`);
    expect(partProposal.body).toMatchObject({
      statement: {
        property: { id: parts.property },
        value: { type: 'value', content: parts.id },
        qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '3' } }],
      },
    });
    expect(partProposal.body).not.toHaveProperty('expectedReader');

    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const fixture = workPartsFixture();
      await activate(fixture);
      const held = delay((data) => 'stream' in data);
      await ui.render(createElement(WorkPartsSession, { id: fixture.id, locale: 'en' }));
      await held.entered.promise;
      await ui.update(signedIn(replacement));
      await ui.until(() => ui.buttons(m.work_parts_correct()).length > 0);
      const count = fixture.calls.length;
      await deliver(held, delivery);
      expect(fixture.calls).toHaveLength(count);
      expect(ui.buttons(m.work_parts_correct()).length).toBeGreaterThan(0);
    }
    // A live correction survives an unrelated slice change, but its old onSelected
    // cannot reread that slice or the replacement reader's page.
    for (const transition of ['reader', 'slice'] as const) {
      const retiringParts = workPartsFixture('partial');
      await activate(retiringParts);
      await ui.render(createElement(WorkPartsSession, { id: retiringParts.id, locale: 'en' }));
      await ui.until(() => ui.buttons(m.work_parts_correct()).length > 0);
      await ui.click(m.work_parts_correct());
      await ui.click(m.relation_open());
      await ui.until(() => ui.buttons(m.relation_propose()).length > 0);
      await propose();
      await ui.until(() => ui.buttons(m.candidate_accept()).length > 0);
      await ui.click(m.candidate_accept());
      await ui.click(m.candidate_accept());
      await ui.until(() => ui.host.textContent!.includes(m.candidate_accepted()));
      // The accepted result is reread explicitly, preserving separate decision/adoption heads.
      await ui.click(m.candidate_reload());
      await ui.until(() => ui.buttons(m.candidate_review()).length > 0);
      await ui.click(m.candidate_review());
      await ui.until(() => ui.buttons(m.candidate_adopt()).length > 0);
      await ui.click(m.candidate_adopt());
      const selectedLate = delay((data) => data.operation === 'adopt');
      await ui.click(m.candidate_adopt());
      await selectedLate.entered.promise;
      if (transition === 'reader') {
        await ui.update(signedIn(replacement));
        await ui.until(() => ui.buttons(m.work_parts_correct()).length > 0);
      } else {
        await ui.click(m.work_parts_more());
        await ui.until(() => ui.host.textContent!.includes('Volume Ten'));
      }
      const partsCount = retiringParts.calls.length;
      await deliver(selectedLate, 'success');
      expect(retiringParts.calls).toHaveLength(partsCount);
    }

    // Consent private candidate, confirmation controls and focus never cross readers.
    for (const stage of ['read', 'change', 'public'] as const) {
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        const fixture = consentFixture();
        await activate(fixture, 'target-owner');
        let held: Gate;
        if (stage === 'read') {
          held = delay((data) => !('operation' in data) && 'cursor' in data);
          await ui.render(createElement(Consent, { address: fixture.address, locale: 'en' }));
          await ui.click(m.statement_consent_open());
        } else {
          await consent(fixture);
          if (stage === 'change') {
            await consentConfirmation();
            held = delay((data) => data.operation === 'disclose');
            await ui.click(m.statement_consent_confirm());
          } else {
            held = delay((_data, raw) => 'terminal' in raw);
            await ui.click(m.statement_consent_refresh_public());
          }
        }
        await held!.entered.promise;
        const old = [...ui.host.querySelectorAll('button')].map((button) => ui.queued(button));
        await ui.update(signedIn(replacement));
        expect(ui.host.textContent).not.toContain('River Ink');
        expect(ui.buttons(m.statement_consent_confirm())).toHaveLength(0);
        const count = fixture.calls.length;
        const requests = envelopes.length;
        ui.outside.focus();
        await act(async () => {
          for (const callback of old) void callback();
        });
        await deliver(held!, delivery);
        expect(fixture.calls).toHaveLength(count);
        expect(envelopes).toHaveLength(requests);
        expect(ui.window.document.activeElement).toBe(ui.outside);
        await ui.update(signedIn());
        expect(ui.host.textContent).not.toContain('River Ink');
      }
    }
    // Queued cancel/focus and change controls also retire in batched ABA before effects.
    const abaConsent = consentFixture();
    await activate(abaConsent, 'target-owner');
    await consent(abaConsent);
    await consentConfirmation();
    const cancel = ui.queued(ui.button(m.candidate_cancel()));
    const confirm = ui.queued(ui.button(m.statement_consent_confirm()));
    const consentCount = abaConsent.calls.length;
    ui.outside.focus();
    await act(async () => {
      ui.client.setQueryData(sessionQuery.queryKey, signedIn(replacement));
      ui.client.setQueryData(sessionQuery.queryKey, signedIn());
      void cancel();
      void confirm();
    });
    await ui.settle();
    expect(abaConsent.calls).toHaveLength(consentCount);
    expect(ui.window.document.activeElement).toBe(ui.outside);
    expect(ui.buttons(m.statement_consent_confirm())).toHaveLength(0);

    const uncertainConsent = consentFixture('lost-response');
    await activate(uncertainConsent, 'target-owner');
    await consent(uncertainConsent);
    await consentConfirmation();
    await ui.click(m.statement_consent_confirm());
    await ui.until(() => ui.buttons(m.candidate_retry()).length > 0);
    const disclosure = structuredClone(uncertainConsent.calls.find((call) => call.path.endsWith('/disclose'))!);
    expect(disclosure.body).toBe('');
    expect(disclosure.keyHeader).toContain(disclosure.key!);
    expect(disclosure.authorization).toBe('Bearer target-owner');
    await ui.click(m.candidate_retry());
    await ui.until(() => uncertainConsent.calls.filter((call) => call.path.endsWith('/disclose')).length === 2);
    expect(uncertainConsent.calls.filter((call) => call.path.endsWith('/disclose'))[1]).toEqual(disclosure);
    await ui.until(() => ui.buttons(m.statement_consent_retract()).length > 0);

    // Editorial entry uses its real proposal/lifecycle adapter: an old creation result
    // cannot begin its secondary private read; a fresh replacement can create normally.
    const editorial = editorialContextFixture('create');
    await activate(editorial);
    await ui.render(createElement(Editorial, { locale: 'en' }));
    await input('input[data-editorial-control]', 'Original private context');
    const editorialDelivery = delay((data) => data.operation === 'create');
    await ui.click(m.editorial_create());
    await editorialDelivery.entered.promise;
    await ui.update(signedIn(replacement));
    const editorialCount = editorial.calls.length;
    await deliver(editorialDelivery, 'success');
    expect(editorial.calls).toHaveLength(editorialCount);
    expect(ui.host.textContent).not.toContain(m.editorial_created());
    await input('input[data-editorial-control]', 'Fresh private context');
    await ui.click(m.editorial_create());
    await ui.until(() => ui.host.textContent!.includes(m.editorial_created()));
    const editorialCreates = editorial.calls.filter((call) => call.method === 'POST');
    expect(editorialCreates).toHaveLength(2);
    expect(editorialCreates[1]!.body).toEqual({ labels: { en: 'Fresh private context' } });
    expect(editorialCreates[1]!.headers.get('idempotency-key')).not.toBe(
      editorialCreates[0]!.headers.get('idempotency-key'),
    );
    expect(editorial.calls.at(-1)!.method).toBe('GET');

    // Retiring an open lifecycle dialog must not restore old focus or run its controls.
    const dialogLifecycle = contributionFixture();
    await activate(dialogLifecycle);
    await ui.render(createElement(Lifecycle, { address: dialogLifecycle.address, locale: 'en' }));
    await ui.click(m.contribution_withdraw());
    const oldDialogConfirm = ui.queued(ui.button(m.contribution_confirm()));
    const oldDialogCancel = ui.queued(ui.button(m.candidate_cancel()));
    const dialogCount = dialogLifecycle.calls.length;
    ui.outside.focus();
    await act(async () => {
      ui.client.setQueryData(sessionQuery.queryKey, signedIn(replacement));
      ui.client.setQueryData(sessionQuery.queryKey, signedIn());
      void oldDialogCancel();
      void oldDialogConfirm();
    });
    await ui.settle();
    expect(dialogLifecycle.calls).toHaveLength(dialogCount);
    expect(ui.window.document.activeElement).toBe(ui.outside);
    expect(ui.buttons(m.contribution_confirm())).toHaveLength(0);

    // Lifecycle's onClear and finally belong to the exact candidate/admission. Neither
    // late success nor late denial/failure can clear a replacement editor's draft.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const fixture = contributionFixture();
      await activate(fixture);
      await ui.render(createElement(Lifecycle, { address: fixture.address, locale: 'en' }));
      const held = delay((data) => data.operation === 'delete');
      const clearBefore = cleared;
      await withdraw();
      await held.entered.promise;
      const old = ui.queued(ui.button(m.contribution_withdraw()));
      await ui.update(signedIn(replacement));
      const count = fixture.calls.length;
      const requests = envelopes.length;
      await act(async () => {
        void old();
      });
      await deliver(held, delivery);
      expect(fixture.calls).toHaveLength(count);
      expect(envelopes).toHaveLength(requests);
      expect(cleared).toBe(clearBefore);
      expect(ui.host.textContent).not.toContain(m.contribution_deleted());
      expect(ui.buttons(m.contribution_withdraw())[0]!.disabled).toBe(false);
    }
    const lifecycle = contributionFixture('uncertain');
    await activate(lifecycle);
    await ui.render(createElement(Lifecycle, { address: lifecycle.address, locale: 'en' }));
    await withdraw();
    await ui.until(() => ui.buttons(m.contribution_retry()).length > 0);
    const deletion = structuredClone(lifecycle.calls.find((call) => call.method === 'DELETE')!);
    expect(deletion.body).toBeNull();
    expect(deletion.session).toBe('proposal-session');
    await ui.click(m.contribution_retry());
    await ui.until(() => ui.buttons(m.contribution_restore()).length > 0);
    expect(lifecycle.calls.filter((call) => call.method === 'DELETE')[1]).toEqual(deletion);
    await ui.click(m.contribution_restore());
    await ui.click(m.contribution_confirm());
    await ui.until(() => lifecycle.calls.some((call) => call.path.endsWith(':restoreDeleted')));
    expect(lifecycle.calls.find((call) => call.path.endsWith(':restoreDeleted'))!.body).toEqual({});
    expect(ui.host.textContent).toContain(m.contribution_restored());
    // Availability refresh is also retired, with no old selected/private result rendering.
    const availability = delay((data) => !('operation' in data));
    await ui.click(m.contribution_refresh());
    await availability.entered.promise;
    await ui.render(
      createElement(Lifecycle, { address: { ...lifecycle.address, candidate: replacement }, locale: 'en' }),
    );
    const availabilityCount = lifecycle.calls.length;
    await deliver(availability, 'success');
    expect(lifecycle.calls).toHaveLength(availabilityCount);
    expect(ui.host.textContent).not.toContain(m.contribution_restored());
    expect(cacheHeaders.every((value) => value === 'private, no-store')).toBe(true);
  } finally {
    for (const pending of allGates) pending.delivery.resolve('throw');
    allGates.length = 0;
    gate = undefined;
    preparing?.resume.resolve();
    preparing = undefined;
    await ui.close();
  }
}, 60_000);
