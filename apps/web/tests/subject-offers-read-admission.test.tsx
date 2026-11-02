import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import { subjectOfferFixture as offer } from '../src/kernel/fake/subject-offers';
import type { SubjectOffersData, SubjectOffersInput } from '../src/checkout/subject-offers';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/subjects/example' });
const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const page: SubjectOffersData = { kind: 'ready', offers: [offer], next: 'native/+?=#cursor', projectionState: 'ready' };
const calls: SubjectOffersInput[] = [];
let read = async (): Promise<SubjectOffersData> => page;
mock.module('../src/checkout/subject-offers', () => ({ readSubjectOffers: ({ data }: { data: SubjectOffersInput }) => { calls.push(data); return read(); } }));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { SubjectOffersRegion } = await import('../src/checkout/subject-offers-region');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('tokenless session discovery retries exact pages and retires late reads on session, subject, locale and exposure changes', async () => {
  setLocale('en', { reload: false });
  const client = new QueryClient();
  const host = window.document.createElement('div');
  const root = createRoot(host as unknown as HTMLElement);
  let context = { subjectId: offer.targetSubjectId, subjectType: 'work', locale: 'en' };
  const observe = (state = 'signed-in', subject = 'reader-a') => client.setQueryData(['session'], { state, subject, csrfToken: null });
  const render = () => root.render(<QueryClientProvider client={client}><SubjectOffersRegion {...context} /></QueryClientProvider>);
  const flush = async (change = () => {}) => { await act(async () => { change(); await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  const click = async (label: string) => flush(() => {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    expect(button).toBeDefined(); button!.click();
  });
  const rows = () => host.querySelectorAll('h3').length;
  try {
    observe(); await flush(render); await flush();
    expect(rows()).toBe(1); expect(calls).toHaveLength(1); expect(calls[0]!.credentialMode).toBe('session');
    read = async () => ({ kind: 'unavailable' });
    await click(m.subject_purchase_next()); await flush();
    expect(calls.at(-1)!.cursor).toBe('native/+?=#cursor');
    expect(rows()).toBe(0); expect(host.textContent).toContain(m.subject_purchase_unavailable());
    read = async () => page;
    await click(m.subject_purchase_retry()); await flush();
    expect(calls.at(-1)!.cursor).toBe('native/+?=#cursor'); expect(rows()).toBe(1);
    await click(m.subject_purchase_restart()); await flush(); expect(calls.at(-1)!.cursor).toBeUndefined();
    for (const change of [
      () => { observe('signed-in', 'reader-b'); observe(); },
      () => client.setQueryData(['exposure', 'viewer'], ['reading']),
      () => { context = { ...context, subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000099' }; render(); },
      () => { context = { ...context, locale: 'fr' }; render(); },
    ]) {
      let finish!: (page: SubjectOffersData) => void;
      read = () => new Promise((resolve) => { finish = resolve; });
      await click(m.subject_purchase_next({}, { locale: context.locale as 'en' | 'fr' })); expect(rows()).toBe(0);
      read = async () => page;
      await flush(change); await flush(); expect(rows()).toBe(1); expect(calls.at(-1)!.cursor).toBeUndefined();
      await flush(() => finish({ kind: 'denied', status: 403, code: null })); expect(rows()).toBe(1);
    }
    await flush(() => observe('unavailable')); const before = calls.length;
    expect(rows()).toBe(0); await flush(); expect(calls).toHaveLength(before);
    read = async () => ({ kind: 'denied', status: 403, code: null });
    await flush(() => observe()); await flush(); expect(calls).toHaveLength(before + 1);
    expect(host.textContent).toContain(m.subject_purchase_denied({}, { locale: 'fr' }));
    expect(calls.every((input) => input.credentialMode === 'session')).toBe(true);
    read = async () => ({ ...page, offers: [] });
    await flush(() => observe('signed-out')); await flush(); expect(calls.at(-1)!.credentialMode).toBe('anonymous');
    expect(host.textContent).toContain(m.subject_purchase_empty({}, { locale: 'fr' }));
  } finally { await act(async () => root.unmount()); client.clear(); }
});
