import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { CurationRead } from '../src/features/pages/curate-actions';
import {
  canDispatchCurationRead,
  curationReadRetryAt,
  retireCurationReadWait,
  waitAfterCurationRead,
} from '../src/features/pages/curation-read-retry';

const empty: CompositionDocument = { root: { props: {} }, content: [] };
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: empty, details: empty } },
  bases: [],
  types: [],
  routes: [],
};
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d8801';
const success = (value = profile, head = 7): Extract<CurationRead, { ok: true }> => ({
  ok: true,
  reader,
  profile: value,
  head,
  digest: profileDigest(value),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function clickHandler(element: Element): ((event: { preventDefault(): void }) => void) | undefined {
  const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
  if (!key) return;
  return (element as unknown as Record<string, { onClick?: (event: { preventDefault(): void }) => void }>)[key]?.onClick;
}

function invoke(element: Element) {
  return act(async () => {
    clickHandler(element)?.({ preventDefault() {} });
  });
}

test('rate-limited wait binds the current owner and withholds until a manual action', () => {
  const owner = { reader, generation: 1 };
  const wait = waitAfterCurationRead(null, owner, { reason: 'rate-limited', retryAfter: 2 }, 1_000);
  expect(curationReadRetryAt(2, 1_000)).toBe(3_000);
  expect(canDispatchCurationRead(wait, owner, 2_999)).toBe(false);
  expect(canDispatchCurationRead(wait, owner, 3_000)).toBe(true);
  expect(canDispatchCurationRead(wait, { reader, generation: 2 }, 2_999)).toBe(true);
  retireCurationReadWait(wait);
  expect(canDispatchCurationRead(wait, owner, 2_999)).toBe(true);
  expect(waitAfterCurationRead(null, owner, { reason: 'unavailable' }, 1_000)).toBeNull();
});

test('fresh rate-limited admission and ordinary reload wait for a current manual retry', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const clock = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  const { createRoot } = await import('react-dom/client');
  const { QueryClient } = await import('@tanstack/react-query');
  const { PresentationViewEditor } = await import('../src/features/pages/curate-view-editor');
  const { CurationReaderAdmission } = await import('../src/features/pages/curation-reader-admission');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const runtime = await import('../src/paraglide/runtime.js');
  runtime.setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: null });
  const admission = new CurationReaderAdmission(client, null);
  const stop = admission.attach();
  const reads: ReturnType<typeof deferred<CurationRead>>[] = [];
  const transport = {
    read: async () => {
      const work = deferred<CurationRead>();
      reads.push(work);
      return work.promise;
    },
    publish: async () => ({ ok: false as const, reason: 'unavailable' as const, outcome: 'unknown' as const }),
  };
  const tree = () =>
    createElement(PresentationViewEditor, {
      initial: { ok: false, reason: 'unavailable' },
      locale: 'en',
      transport,
      admission,
    });
  const settle = async (ready: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 80 && !ready(); attempt++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready(), label).toBe(true);
  };
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  const limited = { ok: false as const, reason: 'rate-limited' as const, retryAfter: 1 };
  try {
    await act(async () => root.render(tree()));
    await settle(() => reads.length === 1, 'fresh admission read');
    await act(async () => reads[0]!.resolve(limited));
    await settle(() => !!button(m.curation_reload()), 'rate-limited retry control');
    expect(host.textContent).toContain(m.curation_limited());
    expect(host.textContent).toContain(m.curation_retry_after({ seconds: 1 }));
    expect(host.textContent).not.toContain(m.curation_heading());
    expect(button(m.curation_reload())!.disabled).toBe(true);
    await invoke(button(m.curation_reload())!);
    expect(reads).toHaveLength(1);

    now += 1_001;
    await act(async () => root.render(tree()));
    expect(reads).toHaveLength(1);
    expect(button(m.curation_reload())!.disabled).toBe(false);
    await act(async () => button(m.curation_reload())!.click());
    await settle(() => reads.length === 2, 'explicit retry after wait');
    await act(async () => reads[1]!.resolve(limited));
    await settle(() => button(m.curation_reload())?.disabled === true, 'repeated refusal wait');
    expect(host.textContent).not.toContain(m.curation_heading());

    now += 1_001;
    await act(async () => root.render(tree()));
    await act(async () => button(m.curation_reload())!.click());
    await settle(() => reads.length === 3, 'successful current retry');
    await act(async () => reads[2]!.resolve(success()));
    await settle(() => host.textContent?.includes(m.curation_heading()) === true, 'admitted editor');
    expect(host.textContent).toContain(m.curation_saved());

    const labeled = (name: string) =>
      [...host.querySelectorAll('label')].find((label) => label.textContent === name)?.control as
        | HTMLSelectElement
        | HTMLInputElement;
    await act(async () => {
      const scope = labeled(m.curation_scope()) as HTMLSelectElement;
      scope.value = 'route';
      scope.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(async () => {
      const key = labeled(m.curation_key()) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(key, '/retry-draft');
      key.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((item) => item.getAttribute('type') === 'submit' && item.textContent?.trim() === m.curation_add())!
        .click();
    });
    await settle(() => host.textContent?.includes(m.curation_unsaved()) === true, 'local draft');
    await act(async () => button(m.curation_reload())!.click());
    await settle(() => !!window.document.querySelector('[role="alertdialog"]'), 'discard-before-reload');
    await act(async () => {
      [...window.document.querySelector('[role="alertdialog"]')!.querySelectorAll('button')]
        .find((item) => item.textContent?.trim() === m.curation_discard_reload())!
        .click();
    });
    await settle(() => reads.length === 4, 'ordinary reload');
    await act(async () => reads[3]!.resolve(limited));
    await settle(() => host.textContent?.includes(m.curation_limited()) === true, 'reload rate-limit');
    expect(host.textContent).toContain(m.curation_unsaved());
    expect(host.textContent).toContain('/retry-draft');
    expect(host.textContent).toContain(m.presentation_editor_version_reference({ head: 7, digest: profileDigest(profile) }));
    expect(button(m.curation_reload())!.disabled).toBe(true);
    await invoke(button(m.curation_reload())!);
    expect(reads).toHaveLength(4);

    now += 1_001;
    await act(async () => root.render(tree()));
    expect(reads).toHaveLength(4);
    const readyReload = clickHandler(button(m.curation_reload())!);
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
      readyReload?.({ preventDefault() {} });
    });
    now += 5_000;
    await act(async () => root.render(tree()));
    expect(reads).toHaveLength(4);
    expect(host.textContent).toContain(m.curation_signed_out());
  } finally {
    stop();
    await act(async () => root.unmount());
    Date.now = clock;
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
