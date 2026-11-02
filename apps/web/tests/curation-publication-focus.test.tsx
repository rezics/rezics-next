import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { withTemplate, type PublishResult } from '../src/features/pages/curate';
import type { CurationPublicationVisit, PublicationTransport } from '../src/features/pages/curation-publish';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/curate/presentation' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { CurationPublication } = await import('../src/features/pages/curation-publish');
const { CurationPublicationRecovery } = await import('../src/features/pages/curation-publish-view');
const { m } = await import('../src/paraglide/messages.js');

const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
});
const later = () =>
  withTemplate(
    profile(),
    { scope: 'route', key: '/books' },
    { root: { props: {} }, content: [{ type: 'Text', props: { id: 'books', text: { en: 'Draft books' } } }] },
  );
const success = (value: PresentationProfile, head: number): PublishResult => ({
  ok: true,
  digest: profileDigest(value),
  head,
});
const unavailable: PublishResult = { ok: false, reason: 'unavailable' };

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;

function region(from: ParentNode = host) {
  return from.querySelector<HTMLElement>(`[aria-label="${m.curation_recovery()}"]`);
}
function action(label: string, from: ParentNode = host) {
  return [...from.querySelectorAll('button')].find((node) => node.textContent === label) ?? null;
}
function pane(id: string) {
  return host.querySelector(`[data-pane="${id}"]`)!;
}
function isActive(node: Element | null) {
  return window.document.activeElement === node;
}

function recovery(
  publication: InstanceType<typeof CurationPublication>,
  visit: CurationPublicationVisit | undefined,
  draft: PresentationProfile,
  head = 7,
) {
  return createElement(CurationPublicationRecovery, {
    publication,
    ...(visit ? { visit } : {}),
    profile: draft,
    head,
    onPublished: () => {},
    onReviewed: () => {},
  });
}

function transport(
  replies: Array<PublishResult | Promise<PublishResult>>,
  read: PublicationTransport['read'] = async () => unavailable,
): PublicationTransport {
  const remaining = [...replies];
  return {
    publish: async () => (await remaining.shift()) ?? unavailable,
    read,
  };
}

async function show(children: ReactNode) {
  root ??= createRoot(host);
  await act(async () => root!.render(children));
}

async function activate(label: string, from: ParentNode = host) {
  const button = action(label, from)!;
  button.focus();
  await act(async () => button.click());
}

async function open(
  replies: Array<PublishResult | Promise<PublishResult>>,
  read?: PublicationTransport['read'],
) {
  const channel = transport(replies, read);
  const publication = new CurationPublication(reader, channel);
  const visit = publication.activate(channel);
  await visit.start(profile(), 7);
  return { publication, visit };
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.replaceChildren();
});

afterAll(async () => {
  for (const [key, descriptor] of previous)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  await window.happyDOM.close();
});

test('focused Retry and revised-intent recover to the named region; a refusal keeps its action', async () => {
  const original = profile();
  const sibling = await open([unavailable]);
  const confirmed = await open([unavailable, success(original, 8)]);
  await show(
    createElement('div', null, [
      createElement(
        'div',
        { key: 'one', 'data-pane': 'one' },
        recovery(confirmed.publication, confirmed.visit, original),
      ),
      createElement(
        'div',
        { key: 'two', 'data-pane': 'two' },
        recovery(sibling.publication, sibling.visit, original),
      ),
    ]),
  );
  await activate(m.curation_retry_original(), pane('one'));
  expect(isActive(region(pane('one')))).toBe(true);
  expect(action(m.curation_retry_original(), pane('one'))).toBeNull();
  expect(action(m.curation_retry_original(), pane('two'))).not.toBeNull();
  expect(isActive(region(pane('two')))).toBe(false);

  const refusal = await open([unavailable, { ok: false, reason: 'forbidden' }]);
  await show(recovery(refusal.publication, refusal.visit, original));
  await activate(m.curation_retry_original());
  expect(isActive(action(m.curation_retry_original()))).toBe(true);

  const revised = later();
  const next = await open([
    { ok: false, reason: 'invalid', errors: [{ pointer: '/generic', code: 'invalid' }] },
    success(revised, 8),
  ]);
  await show(recovery(next.publication, next.visit, revised));
  await activate(m.curation_new_intent());
  expect(action(m.curation_new_intent())).toBeNull();
  expect(isActive(region())).toBe(true);
});

function gate() {
  let finish!: (value: PublishResult) => void;
  const reply = new Promise<PublishResult>((resolve) => {
    finish = resolve;
  });
  return { reply, finish: (value: PublishResult) => finish(value) };
}

test('moved focus, visit replacement, unmount and unactivated success or inspect do not steal keyboard position', async () => {
  const original = profile();
  const moved = gate();
  const delayed = await open([unavailable, moved.reply]);
  await show(
    createElement('div', null, [
      createElement('div', { key: 'recovery' }, recovery(delayed.publication, delayed.visit, original)),
      createElement('button', { key: 'out', 'data-outside': '', type: 'button' }, 'Outside'),
    ]),
  );
  const elsewhere = host.querySelector<HTMLButtonElement>('[data-outside]')!;
  await activate(m.curation_retry_original());
  elsewhere.focus();
  await act(async () => moved.finish(success(original, 8)));
  expect(isActive(elsewhere)).toBe(true);

  const replacedGate = gate();
  const pending = transport([unavailable, replacedGate.reply]);
  const replaced = new CurationPublication(reader, pending);
  const first = replaced.activate(pending);
  await first.start(original, 7);
  await show(recovery(replaced, first, original));
  await activate(m.curation_retry_original());
  let second!: CurationPublicationVisit;
  await act(async () => {
    second = replaced.activate(pending);
  });
  await show(recovery(replaced, second, original));
  await act(async () => replacedGate.finish(success(original, 8)));
  expect(isActive(region())).toBe(false);
  expect(action(m.curation_retry_original())).not.toBeNull();

  const closing = gate();
  const closingChannel = transport([unavailable, closing.reply]);
  const closingPublication = new CurationPublication(reader, closingChannel);
  const closingVisit = closingPublication.activate(closingChannel);
  await closingVisit.start(original, 7);
  await show(recovery(closingPublication, closingVisit, original));
  await activate(m.curation_retry_original());
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () => closing.finish(success(original, 8)));
  expect(region()).toBeNull();

  const published = await open([success(original, 8)]);
  await show(recovery(published.publication, published.visit, original));
  expect(isActive(region())).toBe(false);

  const limited = await open([{ ok: false, reason: 'rate-limited', retryAfter: 30 }]);
  await show(recovery(limited.publication, limited.visit, original));
  expect(isActive(region())).toBe(false);
  expect(isActive(action(m.curation_retry_original()))).toBe(false);

  const watching = await open([unavailable], async () => ({
    ok: true,
    reader,
    head: 8,
    digest: profileDigest(original),
    profile: original,
  }));
  await show(recovery(watching.publication, watching.visit, original));
  await act(async () => watching.visit.inspect());
  expect(isActive(region())).toBe(false);
  expect(isActive(action(m.curation_retry_original()))).toBe(false);
});
