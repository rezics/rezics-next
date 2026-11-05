import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, createContext, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import type { CandidateCommand, CandidateRead, CandidateResult } from '../src/subject/candidates';
import * as start from '../.storybook/react-start';
import recorded from '../src/kernel/recorded/definitions-release.json';

// Authored UNRUN: one mounted, connected Subject / Context / catalogue regression.
// The BFF uses real prepareSession and its per-Request subject/credential maps. Only the
// session store and native HTTP boundary are request mocks; they establish no native proof.
const original = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const replacement = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const csrf = 'AAAAAAAAAAAAAAAAAAAAAA';
let serverReader = original;
let currentRequest: Request;
let nativeClient: ReturnType<typeof createKernelClient>;
let release: unknown = recorded.release;
const cacheHeaders: string[] = [];
const envelopes: { data: Record<string, unknown>; request: Request }[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Gate = {
  operation: 'read' | 'confirm';
  entered: ReturnType<typeof deferred<void>>;
  delivery: ReturnType<typeof deferred<'success' | 'failure' | 'throw'>>;
};
let gate: Gate | undefined;
let preparing: { entered: ReturnType<typeof deferred<void>>; resume: ReturnType<typeof deferred<void>> } | undefined;
function delay(operation: Gate['operation']) {
  gate = { operation, entered: deferred<void>(), delivery: deferred<'success' | 'failure' | 'throw'>() };
  return gate;
}
const env = {
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
        const reader = serverReader;
        const held = preparing;
        if (held) {
          preparing = undefined;
          held.entered.resolve();
          await held.resume.promise;
        }
        return { status: 'active', subject: reader, accessToken: `access-${reader}`, csrfToken: csrf };
      },
    }),
  },
};
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => {
    if (name.toLowerCase() === 'cache-control') cacheHeaders.push(value);
  },
}));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: (_options: unknown) => {
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
          // A real request carries the submitted CSRF header, including negative cases.
          currentRequest = new Request('https://site.test/en/_server/candidates', { method: 'POST', headers });
          const request = currentRequest;
          const candidate = !!data && typeof data === 'object' && 'expectedReader' in data;
          const operation = candidate && 'operation' in data ? 'confirm' : 'read';
          const held = candidate && gate?.operation === operation ? gate : undefined;
          if (held) gate = undefined;
          if (candidate) envelopes.push({ data: structuredClone(data) as Record<string, unknown>, request });
          const result = await handler({ data });
          if (!held) return result;
          held.entered.resolve();
          const delivery = await held.delivery.promise;
          if (delivery === 'throw') throw new Error('Late transport failure');
          return delivery === 'failure' ? { ok: false, reason: 'unavailable' } : result;
        };
      },
    };
    return chain;
  },
}));
mock.module('../src/kernel/client', () => ({ kernelClient: () => nativeClient, requestLocale: () => 'en' }));
mock.module('../src/subject/definitions', () => ({ readRelease: async () => release }));
// Keep unrelated presentation and Context management editors outside this candidate exercise.
mock.module('../src/features/pages/curate-view-editor', () => ({ PresentationViewEditor: () => null }));
mock.module('../src/features/pages/presentation-preview-view', () => ({
  PresentationPreviewPanel: () => null,
  PresentationPreviewContext: createContext(null),
}));
mock.module('../src/features/catalogue/editorial-context-session', () => ({
  EditorialContextSession: ({ id, children }: { id: string; children: (id: string) => ReactNode }) => children(id),
}));

const { candidateFixture, candidateProperty } = await import('../src/kernel/fake/subject-candidates');
const { contextFixture } = await import('../src/kernel/fake/context-curation');
const { identifiersProfileFixture, identifiersCandidate } =
  await import('../src/kernel/fake/catalogue-identifiers-profile');
const { candidateSession } = await import('../src/subject/candidate-lifetime');
const { SubjectCandidateCuration } = await import('../src/features/pages/curate-view');
const { ContextCurationSession } = await import('../src/features/catalogue/context-curation-session');
const { IdentifiersProfileSession } = await import('../src/features/catalogue/identifiers-profile-session');
const { readSubjectCandidates, confirmSubjectCandidate } = await import('../src/features/pages/curate-actions');
const { readSubjectContext, confirmSubjectContext } =
  await import('../src/features/catalogue/context-curation-actions');
const { readCorrectionReview, confirmCorrection } = await import('../src/features/catalogue/statement-editor-actions');
const { loadAuthoredReview, confirmAuthoredField } = await import('../src/features/catalogue/authored-field-actions');
const { loadGameClassificationReview } = await import('../src/features/catalogue/game-profile-actions');
const { loadRecipeReview, confirmRecipeReview } = await import('../src/features/catalogue/recipe-editor-actions');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');

const signedIn = (subject = original, csrfToken = csrf) => ({ state: 'signed-in' as const, subject, csrfToken });
const headers = { 'X-CSRF-Token': csrf };
type Fixture = ReturnType<typeof candidateFixture>;
type NativeCall = Fixture['calls'][number];

// Also mount the actual reviewer through the catalogue ExactReview handoff. The real
// IdentifiersProfileSession below exercises its retained factory/continuity closure.
const { ExactReview } = await import('../src/features/catalogue/subject-facts-view');
const ExactCatalogue = candidateSession(function ExactCatalogue({
  fixture,
  target,
  locale,
}: {
  fixture: Fixture;
  target: string;
  locale: string;
}) {
  return createElement(ExactReview, {
    id: fixture.id,
    locale,
    address: { property: fixture.property, candidate: target, session: 'origin-continuity' },
    review: () => ({
      read: (property, cursor, session, work) =>
        readSubjectCandidates({
          data: { id: fixture.id, property, cursor, session, expectedReader: work?.reader },
          headers,
        }),
      confirm: (data, work) =>
        !work?.live() ? Promise.resolve({ ok: false, reason: 'denied' }) : confirmSubjectCandidate({ data, headers }),
    }),
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
    [...host.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
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
    const props = Reflect.get(element, key) as { onClick: (event: { currentTarget: object }) => void };
    return () => props.onClick({ currentTarget: element });
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

// This is intentionally a single connected mounted campaign. Do not replace its wiring
// with a helper-only lifecycle oracle or mark it as executed in this source delivery.
test('original-reader candidate admission, late replies, queued ABA, exact retries and fresh Subject/Context/catalogue usability', async () => {
  const ui = await mounted();
  const fresh = () => {
    const fixture = candidateFixture();
    nativeClient = fixture.client;
    release = recorded.release;
    serverReader = original;
    return fixture;
  };
  const openSubject = async (fixture: Fixture) => {
    await ui.render(createElement(SubjectCandidateCuration, { id: fixture.id, locale: 'en' }));
    await ui.click(m.candidate_entry());
    await ui.until(() => !!ui.host.querySelector('#candidate-field'));
    await ui.field(fixture.property);
    await ui.until(() => ui.buttons(m.candidate_review()).length > 0);
  };
  const compare = async () => {
    await ui.click(m.candidate_review());
    await ui.until(() => ui.buttons(m.candidate_accept()).length > 0 || ui.buttons(m.candidate_reject()).length > 0);
  };
  const confirm = async () => {
    const label = ui.buttons(m.candidate_accept()).length ? m.candidate_accept() : m.candidate_reject();
    await ui.click(label);
    await ui.click(label);
  };
  try {
    // Both private-read and confirmation deliveries are held AFTER real BFF admission/native
    // processing, so retirement tests success, returned failure and thrown failure paths.
    for (const operation of ['read', 'confirm'] as const) {
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        await ui.render(null);
        await ui.update(signedIn());
        const fixture = fresh();
        if (operation === 'confirm') {
          await openSubject(fixture);
          await compare();
        } else {
          await ui.render(createElement(SubjectCandidateCuration, { id: fixture.id, locale: 'en' }));
          await ui.click(m.candidate_entry());
          await ui.until(() => !!ui.host.querySelector('#candidate-field'));
        }
        const held = delay(operation);
        if (operation === 'read') await ui.field(candidateProperty);
        else await confirm();
        await held.entered.promise;
        const before = envelopes.length;
        const oldControl = ui.button(operation === 'read' ? m.candidate_close() : m.candidate_accept());
        const callback = ui.queued(oldControl);
        // Retire synchronously, then invoke a callback already queued from the old DOM before
        // React has run a cleanup/effect. Cache notifications must fence even a batched ABA.
        await act(async () => {
          ui.client.setQueryData(sessionQuery.queryKey, signedIn(replacement));
          ui.client.setQueryData(sessionQuery.queryKey, signedIn());
          callback();
        });
        expect(envelopes.length).toBe(before);
        ui.outside.focus();
        held.delivery.resolve(delivery);
        await ui.settle();
        expect(ui.window.document.activeElement).toBe(ui.outside);
        expect(ui.host.querySelector('#candidate-field')).toBeNull();
        expect(ui.host.querySelector('[id^="include-"]')).toBeNull();
        expect(ui.buttons(m.candidate_review()).length).toBe(0);
        // The replacement can immediately start its own read and native confirmation.
        await ui.update(signedIn(replacement));
        await ui.click(m.candidate_entry());
        await ui.until(() => !!ui.host.querySelector('#candidate-field'));
        await ui.field(candidateProperty);
        await compare();
        await confirm();
        await ui.until(() => ui.buttons(m.candidate_reload()).length > 0);
        const current = envelopes.slice(before).filter((entry) => entry.data.expectedReader === replacement);
        expect(current.some((entry) => entry.data.operation === 'accept' || entry.data.operation === 'reject')).toBe(
          true,
        );
        expect(current.find((entry) => !entry.data.operation)?.data.session).toBeUndefined();
        expect(
          fixture.calls.some((call) => call.method === 'POST' && call.authorization === `Bearer access-${replacement}`),
        ).toBe(true);
      }
    }

    // A retired finally must not clear a replacement's outstanding private read or focus it.
    await ui.render(null);
    await ui.update(signedIn());
    const busyFixture = fresh();
    await ui.render(createElement(SubjectCandidateCuration, { id: busyFixture.id, locale: 'en' }));
    await ui.click(m.candidate_entry());
    await ui.until(() => !!ui.host.querySelector('#candidate-field'));
    const oldBusy = delay('read');
    await ui.field(busyFixture.property);
    await oldBusy.entered.promise;
    await ui.update(signedIn(replacement));
    await ui.click(m.candidate_entry());
    await ui.until(() => !!ui.host.querySelector('#candidate-field'));
    const freshBusy = delay('read');
    await ui.field(busyFixture.property);
    await freshBusy.entered.promise;
    const freshPendingText = ui.host.textContent;
    expect(freshPendingText).toContain(m.candidate_loading());
    ui.outside.focus();
    oldBusy.delivery.resolve('success');
    await ui.settle();
    expect(ui.host.textContent).toBe(freshPendingText);
    expect(ui.host.querySelector('#candidate-field')?.hasAttribute('disabled')).toBe(true);
    expect(ui.window.document.activeElement).toBe(ui.outside);
    freshBusy.delivery.resolve('success');
    await ui.until(() => ui.buttons(m.candidate_review()).length > 0);
    await compare();
    await confirm();
    await ui.until(() => ui.buttons(m.candidate_reload()).length > 0);

    // Admission loss retires a private page before it arrives. Returning the same account
    // starts closed and cannot revive old pages, drafts, outcomes or continuity.
    for (const state of ['signed-out', 'unavailable'] as const) {
      await ui.render(null);
      await ui.update(signedIn());
      const fixture = fresh();
      await ui.render(createElement(SubjectCandidateCuration, { id: fixture.id, locale: 'en' }));
      const held = delay('read');
      await ui.click(m.candidate_entry());
      await held.entered.promise;
      await ui.update({ state, subject: null, csrfToken: null });
      held.delivery.resolve('success');
      await ui.settle();
      expect(ui.host.querySelector('#candidate-review')).toBeNull();
      await ui.update(signedIn());
      expect(ui.host.querySelector('#candidate-field')).toBeNull();
    }

    // Exact-target, address and locale changes retire outstanding work independently of reader.
    // The actual catalogue ExactReview still accepts a new target immediately while old work waits.
    for (const changed of ['target', 'address', 'locale', 'unmount', 'admission'] as const) {
      for (const operation of ['read', 'confirm'] as const) {
        for (const delivery of ['success', 'failure', 'throw'] as const) {
          await ui.render(null);
          await ui.update(signedIn());
          const fixture = fresh();
          const held = operation === 'read' ? delay('read') : undefined;
          await ui.render(createElement(ExactCatalogue, { fixture, target: fixture.candidate.id, locale: 'en' }));
          let pending = held;
          if (operation === 'confirm') {
            await ui.until(() => ui.buttons(m.candidate_accept()).length > 0);
            pending = delay('confirm');
            await confirm();
          }
          await pending!.entered.promise;
          const nextTarget = `${fixture.candidate.id.slice(0, -3)}999`;
          const nextFixture = changed === 'address' ? { ...fixture, id: `${fixture.id.slice(0, -3)}777` } : fixture;
          if (changed === 'admission') await ui.update({ state: 'unavailable', subject: null, csrfToken: null });
          else
            await ui.render(
              changed === 'unmount'
                ? null
                : createElement(ExactCatalogue, {
                    fixture: nextFixture,
                    target: changed === 'target' ? nextTarget : fixture.candidate.id,
                    locale: changed === 'locale' ? 'ja' : 'en',
                  }),
            );
          await ui.settle();
          const before = envelopes.length;
          const visible = ui.host.textContent;
          ui.outside.focus();
          pending!.delivery.resolve(delivery);
          await ui.settle();
          expect(envelopes.length).toBe(before);
          expect(ui.window.document.activeElement).toBe(ui.outside);
          expect(ui.host.textContent).toBe(visible);
        }
      }
    }

    // Same-live-reader uncertain retries retain every native field, original continuity and key.
    await ui.render(null);
    await ui.update(signedIn());
    const uncertain = candidateFixture('multiple');
    nativeClient = uncertain.client;
    release = recorded.release;
    await openSubject(uncertain);
    const choice = ui.host.querySelector(`[id="include-${uncertain.candidate.id}"]`)! as InstanceType<
      typeof ui.window.HTMLElement
    >;
    await act(async () => choice.click());
    expect(choice.getAttribute('aria-checked')).toBe('true');
    // An ordinary parent render preserves the healthy multivalue draft and off-page public choice.
    await ui.render(createElement(SubjectCandidateCuration, { id: uncertain.id, locale: 'en' }));
    expect(ui.host.querySelector(`[id="include-${uncertain.candidate.id}"]`)?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(ui.host.querySelector(`[id="include-${uncertain.candidates[2]!.id}"]`)).not.toBeNull();
    await ui.click(m.candidate_adopt());
    const held = delay('confirm');
    await ui.click(m.candidate_adopt());
    await held.entered.promise;
    held.delivery.resolve('failure');
    await ui.settle();
    const first = envelopes.filter((entry) => entry.data.operation).at(-1)!.data;
    await ui.click(m.candidate_retry());
    await ui.until(() => envelopes.filter((entry) => entry.data.operation).at(-1)!.data !== first);
    const second = envelopes.filter((entry) => entry.data.operation).at(-1)!.data;
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      operation: 'adopt',
      expectedReader: original,
      session: 'candidate-session',
      head: 1,
    });
    expect((first.selection as unknown[]).length).toBe(3);
    expect(uncertain.calls.filter((call) => call.path.endsWith('/candidates')).length).toBe(1);
    const native = uncertain.calls.filter((call) => call.method === 'POST');
    expect(native.length).toBe(2);
    expect(native[1]).toEqual(native[0]);
    // Another uncertain attempt is retired permanently, including a retained queued Retry callback.
    await ui.render(null);
    const retired = fresh();
    await openSubject(retired);
    await compare();
    const lost = delay('confirm');
    await confirm();
    await lost.entered.promise;
    lost.delivery.resolve('failure');
    await ui.settle();
    const retry = ui.queued(ui.button(m.candidate_retry()));
    const count = envelopes.length;
    await ui.update(signedIn(replacement));
    await act(async () => retry());
    await ui.update(signedIn());
    await act(async () => retry());
    expect(envelopes.length).toBe(count);
    expect(ui.host.querySelector('#candidate-field')).toBeNull();

    // Context wiring retains inherit/replace/suppress and its exact slot/mode on a live retry.
    await ui.render(null);
    await ui.update(signedIn());
    const context = contextFixture();
    nativeClient = context.client;
    release = context.release;
    await ui.render(
      createElement(ContextCurationSession, {
        id: context.id,
        context: context.context.id,
        property: context.property,
        locale: 'en',
      }),
    );
    await ui.click(m.candidate_entry());
    await ui.until(() => !!ui.host.querySelector('#context-mode'));
    await act(async () => {
      const mode = ui.host.querySelector('#context-mode')! as InstanceType<typeof ui.window.HTMLSelectElement>;
      mode.value = 'suppress';
      mode.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    });
    await ui.click(m.context_adopt());
    const contextLost = delay('confirm');
    await ui.click(m.context_adopt());
    await contextLost.entered.promise;
    contextLost.delivery.resolve('failure');
    await ui.settle();
    const contextCommand = envelopes.filter((entry) => entry.data.context).at(-1)!.data;
    await ui.click(m.candidate_retry());
    await ui.settle();
    expect(envelopes.filter((entry) => entry.data.context).at(-1)!.data).toEqual(contextCommand);
    expect(contextCommand).toMatchObject({
      context: context.context.id,
      mode: 'suppress',
      selection: [],
      expectedReader: original,
    });
    expect(context.calls.filter((call) => call.method === 'POST').length).toBe(2);

    // Actual profile-session factory: no late private read may overwrite its next reader's
    // continuity, and the replacement can confirm via the same installed shared reviewer.
    await ui.render(null);
    await ui.update(signedIn());
    const catalogue = identifiersProfileFixture();
    nativeClient = catalogue.client;
    release = catalogue.release;
    const proposed = await catalogue.transport.propose({
      id: catalogue.publicRead.subject.id,
      key: crypto.randomUUID(),
      statement: {
        property: { id: 'schema:isbn' },
        value: { type: 'value', content: '978-4-00-000001-7' },
        qualifiers: [],
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example/record' } },
            ],
          },
        ],
      },
    });
    expect(proposed.ok).toBe(true);
    const profile = () =>
      createElement(IdentifiersProfileSession, {
        id: catalogue.publicRead.subject.id,
        locale: 'en',
        initialReview: { property: 'schema:isbn', candidate: identifiersCandidate },
      });
    const catalogueRead = delay('read');
    await ui.render(profile());
    await catalogueRead.entered.promise;
    await ui.update(signedIn(replacement));
    await ui.until(() => ui.buttons(m.candidate_accept()).length > 0);
    const nextRead = envelopes
      .filter((entry) => entry.data.expectedReader === replacement && !entry.data.operation)
      .at(-1)!;
    expect(nextRead.data.session).toBeUndefined();
    ui.outside.focus();
    catalogueRead.delivery.resolve('success');
    await ui.settle();
    expect(ui.window.document.activeElement).toBe(ui.outside);
    await confirm();
    await ui.settle();
    expect(envelopes.filter((entry) => entry.data.operation).at(-1)!.data.expectedReader).toBe(replacement);

    // Every real candidate BFF refuses a mismatched expected reader BEFORE any native I/O.
    // POST, CSRF and private/no-store are retained, and no caller stamp supplies authorization.
    await ui.render(null);
    const bff = fresh();
    serverReader = replacement;
    const address = { id: bff.id, property: candidateProperty, expectedReader: original };
    const command: CandidateCommand = {
      ...address,
      candidate: bff.candidate.id,
      operation: 'accept',
      head: null,
      key: crypto.randomUUID(),
    };
    const callsBefore = bff.calls.length;
    const refused = await Promise.all([
      readSubjectCandidates({ data: address, headers }),
      confirmSubjectCandidate({ data: command, headers }),
      readSubjectContext({ data: { ...address, context: context.context.id }, headers }),
      confirmSubjectContext({ data: { ...command, context: context.context.id }, headers }),
      readCorrectionReview({ data: address, headers }),
      confirmCorrection({ data: command, headers }),
      loadAuthoredReview({ data: { ...address, candidate: command.candidate }, headers }),
      confirmAuthoredField({ data: command, headers }),
      loadGameClassificationReview({ data: address, headers }),
      loadRecipeReview({ data: address, headers }),
      confirmRecipeReview({ data: command, headers }),
    ]);
    expect(bff.calls.length).toBe(callsBefore);
    for (const result of refused)
      expect('comparison' in result ? result.comparison : result).toEqual({ ok: false, reason: 'denied' });
    expect(cacheHeaders.length).toBeGreaterThan(0);
    expect(cacheHeaders.every((value) => value === 'private, no-store')).toBe(true);
    expect(envelopes.every((entry) => entry.request.method === 'POST')).toBe(true);
    await expect(
      readSubjectCandidates({
        data: { ...address, expectedReader: replacement },
        headers: { 'X-CSRF-Token': 'invalid' },
      }),
    ).rejects.toBeDefined();
    expect(bff.calls.length).toBe(callsBefore);
    await expect(
      readSubjectCandidates({ data: { ...address, expectedReader: `${replacement}\n` }, headers }),
    ).rejects.toBeDefined();
    // Pause preparation, replace the ambient request, and then finish preparation. Reader and
    // credential must both come from the saved original Request, never two getRequest calls.
    serverReader = original;
    const preparation = { entered: deferred<void>(), resume: deferred<void>() };
    preparing = preparation;
    const preparingRead = readSubjectCandidates({ data: address, headers });
    await preparation.entered.promise;
    const preparedRequest = currentRequest;
    serverReader = replacement;
    const mismatchWhilePreparing = await readSubjectCandidates({ data: address, headers });
    expect(mismatchWhilePreparing).toEqual({ ok: false, reason: 'denied' });
    expect(currentRequest).not.toBe(preparedRequest);
    expect(bff.calls.length).toBe(callsBefore);
    preparation.resume.resolve();
    expect((await preparingRead).ok).toBe(true);
    expect(bff.calls.filter((call: NativeCall) => call.path.endsWith('/candidates')).at(-1)?.authorization).toBe(
      `Bearer access-${original}`,
    );
    const admitted: CandidateRead = await readSubjectCandidates({
      data: { ...address, expectedReader: replacement },
      headers,
    });
    expect(admitted.ok).toBe(true);
    expect(bff.calls.filter((call: NativeCall) => call.path.endsWith('/candidates')).at(-1)?.authorization).toBe(
      `Bearer access-${replacement}`,
    );
    const accepted: CandidateResult = await confirmSubjectCandidate({
      data: { ...command, expectedReader: replacement },
      headers,
    });
    expect(accepted.ok).toBe(true);
  } finally {
    await ui.close();
  }
}, 60_000);
