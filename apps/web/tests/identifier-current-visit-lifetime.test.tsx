import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type {
  IdentifierEvidenceRead,
  IdentifierEvidenceTransport,
} from '../src/features/catalogue/identifier-current-visit-evidence';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { identifierVisitExample, identifierExampleAddress, identifierExampleDuplicate } =
  await import('../src/features/catalogue/identifier-current-visit-examples');
const { identifierEvidenceFromPage, survivingIdentifierOccurrence } =
  await import('../src/features/catalogue/identifier-current-visit-evidence');
const { IdentifierCurrentVisit, IdentifierOccurrence } =
  await import('../src/features/catalogue/identifier-current-visit-view');
const { identifierRouteHref } = await import('../src/features/catalogue/identifier-current-visit');

test('the public origin binds the exact returned Realm and Context and gates disclosure before exact inspection', () => {
  const { page, read, origin, evidence } = identifierVisitExample();
  expect(
    identifierEvidenceFromPage(
      { ...page, context: { ...page.context!, id: 'another-context' } },
      read.subject.id,
      origin,
    ),
  ).toEqual({ kind: 'changed' });
  expect(identifierEvidenceFromPage({ ...page, requestedRealm: 'another-realm' }, read.subject.id, origin)).toEqual({
    kind: 'changed',
  });
  expect(
    identifierEvidenceFromPage(
      { ...page, catalogue: { ...page.catalogue!, type: 'schema:Book' } },
      read.subject.id,
      origin,
    ),
  ).toEqual({ kind: 'unavailable' });
  const original = evidence.subject.statements['schema:isbn']![0]!;
  const duplicate = evidence.subject.statements['schema:isbn']![1]!;
  expect(original.value).toEqual(duplicate.value);
  const html = renderToStaticMarkup(
    createElement(IdentifierOccurrence, { evidence, property: 'schema:isbn', statement: duplicate, locale: 'en' }),
  );
  expect(html).toContain('https://catalogue.example/second');
  expect(html).not.toContain('A%2Fb');
  expect(html).toContain('A particular edition');
  expect(html).toContain('ISBN-13');
  expect(html).toContain('Normal');
  expect(survivingIdentifierOccurrence(evidence, evidence, identifierExampleAddress)).toBe(true);
  for (const changed of [
    { ...evidence, digest: 'new-release' },
    { ...evidence, subject: { ...evidence.subject, type: 'schema:Book' } },
    { ...evidence, subject: { ...evidence.subject, context: 'new-context' } },
    { ...evidence, subject: { ...evidence.subject, statements: { 'schema:isbn': [duplicate] } } },
    { ...evidence, subject: { ...evidence.subject, statements: { 'schema:isbn': [{ ...original, references: [] }] } } },
  ])
    expect(survivingIdentifierOccurrence(evidence, changed, identifierExampleAddress)).toBe(false);
  original.qualifiers.push({
    property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
    value: { type: 'value', content: { amount: '+1', unit: '1' } },
  });
  // The page read is the input; the projection owns its spoiler gate before serializing the visit.
  read.subject.statements['schema:isbn']![0]!.qualifiers = original.qualifiers;
  const withheld = identifierEvidenceFromPage(page, read.subject.id, origin);
  expect(withheld.kind === 'ready' && withheld.evidence.subject.statements['schema:isbn']!.map((s) => s.id)).toEqual([
    identifierExampleDuplicate,
  ]);
});

const deferred = () => {
  let resolve!: (read: IdentifierEvidenceRead) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<IdentifierEvidenceRead>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test('mounted visits retire delayed A/B/A, equal-principal observations, new review intent and source replacement; fresh return never steals focus', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/example/identifiers' });
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
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const client = new QueryClient();
  const session = { state: 'signed-in', subject: 'reader-A', csrfToken: 'one' };
  client.setQueryData(['session'], session);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const fixture = identifierVisitExample();
  let transport: IdentifierEvidenceTransport;
  let review: { property: string; candidate: string } | undefined;
  const requests: ReturnType<typeof deferred>[] = [];
  const newTransport = () => ({
    read: () => {
      const read = deferred();
      requests.push(read);
      return read.promise;
    },
  });
  transport = newTransport();
  const show = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <IdentifierCurrentVisit
            id={fixture.read.subject.id}
            locale="en"
            origin={fixture.origin}
            initialInspection={identifierExampleAddress}
            initialReview={review}
            transport={transport}
            editorHref={identifierRouteHref('en', fixture.read.subject.id, 'edition', { origin: fixture.origin })}
          />
        </QueryClientProvider>,
      ),
    );
  const flush = () =>
    act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  const finish = async (read = fixture.result) => {
    await act(async () => requests.at(-1)!.resolve(read));
    await flush();
  };
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  const click = async (text: string) => {
    await act(async () => button(text).click());
    await flush();
  };
  const exact = () => host.querySelector('[data-slot="identifier-exact-occurrence"]');
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const focusFrames = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  };
  try {
    await show();
    const lateA = requests[0]!;
    await act(async () => {
      client.setQueryData(['session'], { ...session, subject: 'reader-B' });
    });
    await show();
    const lateB = requests.at(-1)!;
    await act(async () => {
      client.setQueryData(['session'], session);
    });
    await show();
    await act(async () => {
      lateA.resolve({
        kind: 'ready',
        evidence: { ...fixture.evidence, subject: { ...fixture.evidence.subject, labels: { en: 'old A' } } },
      });
      lateB.resolve(fixture.result);
    });
    await flush();
    expect(exact()).toBeNull();
    expect(host.textContent).not.toContain('old A');
    await finish();
    expect(exact()).not.toBeNull();
    for (const change of [
      () => client.setQueryData(['session'], { ...session }),
      () => {
        review = { property: 'schema:url', candidate: identifierExampleDuplicate };
      },
      () => {
        transport = newTransport();
      },
    ]) {
      await act(async () => {
        change();
      });
      await show();
      expect(exact()).toBeNull();
      await finish();
      expect(exact()).not.toBeNull();
    }
    await click('Return to the refreshed public reading');
    expect(exact()).toBeNull();
    await finish();
    focusFrames();
    expect(window.document.activeElement?.textContent).toBe('Inspect this exact assertion');
    await click('Inspect this exact assertion');
    await click('Return to the refreshed public reading');
    // Interaction while the fresh read is pending cancels its eventual focus.
    host.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await finish();
    focusFrames();
    expect(window.document.activeElement?.textContent).not.toBe('Inspect this exact assertion');
    await click('Inspect this exact assertion');
    await click('Return to the refreshed public reading');
    const changed = { ...fixture.evidence, digest: 'changed-release' };
    await act(async () => requests.at(-1)!.resolve({ kind: 'ready', evidence: changed }));
    await flush();
    focusFrames();
    expect(window.document.activeElement?.textContent).toBe('Public identifier evidence');
    await click('Inspect this exact assertion');
    await click('Return to the refreshed public reading');
    await finish();
    expect(frames.size).toBe(1);
    host.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(frames.size).toBe(0);
    await click('Inspect this exact assertion');
    await click('Return to the refreshed public reading');
    await act(async () => requests.at(-1)!.reject(new Error('Origin response disconnected')));
    await flush();
    focusFrames();
    expect(host.querySelector('[data-slot="identifier-exact-occurrence"]')).toBeNull();
    expect(button('Inspect this exact assertion')).toBeUndefined();
    expect(host.textContent).toContain('unavailable');
    await click('Refresh public reading');
    await finish();
    await click('Inspect this exact assertion');
    await click('Return to the refreshed public reading');
    await finish();
    expect(frames.size).toBe(1);
    await act(async () => root.render(null));
    expect(frames.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
