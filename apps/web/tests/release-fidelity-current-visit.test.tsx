import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { candidateContext } from '../src/subject/candidates';
import { occurrenceFor } from '../src/features/catalogue/release-fidelity/reading/state';
import {
  releaseReturnHref,
  releaseSearch,
  releaseVisitFromHash,
  releaseVisitReturn,
  type ReleaseVisit,
} from '../src/features/catalogue/release-fidelity/navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import type { ReleaseFidelityTransport } from '../src/features/catalogue/release-fidelity/view';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { ReleaseFidelityPage } = await import('../src/features/catalogue/release-fidelity/view');
const { m } = await import('../src/paraglide/messages.js');
import {
  releaseVisitExample as fixture,
  visitRelease as source,
  visitContext as selectedContext,
} from '../src/features/catalogue/release-fidelity/examples';
const o = { locale: 'en' as never };

async function eventually(assertion: () => void) {
  for (let i = 0; i < 80; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      if (i === 79) throw error;
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

async function mount(data: ReturnType<typeof fixture>, context = selectedContext, hash = '') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({
    url: `https://site.test/en/subjects/${source}/release/release?context=${context}${hash}`,
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const transport: ReleaseFidelityTransport = {
    read: data.read,
    facts: {
      read: async () => ({ ok: false, reason: 'unavailable' }),
      propose: async () => ({ ok: false, reason: 'uncertain' }),
    },
    relation: () => ({
      read: async () => ({ ok: false, reason: 'unavailable' }),
      propose: async () => ({ ok: false, reason: 'unavailable' }),
      confirm: async () => ({ ok: false, reason: 'unavailable' }),
    }),
    review: () => ({}) as never,
  };
  let setContext: (context: string) => void;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  host.addEventListener('click', (event) => event.preventDefault());
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const route = createRootRoute({
    component: function Visit() {
      const [activeContext, changeContext] = useState(context);
      setContext = changeContext;
      return (
        <ReleaseFidelityPage
          id={source}
          context={activeContext}
          locale="en"
          transport={transport}
          search={async () => []}
        />
      );
    },
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await act(async () => router.load());
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  await act(async () => {
    render();
  });
  await eventually(() => expect(host.querySelector('[data-slot="release-related"] select')).not.toBeNull());
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  const button = (label: string) => {
    const b = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!b) throw Error(label);
    return b;
  };
  return {
    host,
    window,
    click,
    button,
    stream: async (key: string) => {
      await act(async () => {
        const select = host.querySelector('select')!;
        select.value = key;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    },
    context: async (next: string) => {
      await act(async () => {
        setContext(next);
      });
    },
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

test('selected Context release visit keeps exact duplicate occurrence, date, evidence and later-window return', async () => {
  const data = fixture();
  const visit = await mount(data);
  try {
    await visit.stream('forward:rezics:releaseSupersedes');
    await visit.click(visit.button(m.release_fidelity_next({}, o)));
    await eventually(() =>
      expect(visit.host.querySelectorAll('[data-slot="release-related"] ul > li')).toHaveLength(2),
    );
    await visit.click(visit.host.querySelector('[data-slot="release-related"] ul > li button')!);
    await eventually(() => expect(visit.host.querySelector('[data-slot="release-detail-facts"]')).not.toBeNull());
    expect(visit.host.textContent).toContain('Original work 原作');
    expect(visit.host.querySelector('[data-slot="release-context"]')?.textContent).toContain(selectedContext);
    expect(visit.host.textContent).toContain(m.release_fidelity_date_tba({}, o));
    expect(visit.host.querySelector('time')?.getAttribute('datetime')).toContain('2024-05');
    expect(visit.host.textContent).toContain('https://source.example/exact-release');
    expect(visit.host.textContent).toContain('https://vndb.org/r200');
    expect(visit.host.textContent).toContain('https://vndb.org/r123');
    expect(visit.host.querySelector('[data-slot="release-work"] a[href*="/subjects/"]') === null).toBe(true);
    const link = visit.host.querySelector<HTMLAnchorElement>('[data-slot="release-related"] li a')!;
    const destination = new URL(link.href);
    expect(destination.searchParams.get('context')).toBe(selectedContext);
    const back = destination.searchParams.get('via')!;
    expect(subjectVisitReturn(back, 'en')).toBe(back);
    await visit.click(link);
    const oldSession = data.calls.findLast((call) => call.session)?.session;
    data.calls.length = 0;
    await act(async () => {
      visit.window.dispatchEvent(new visit.window.Event('popstate'));
    });
    await eventually(() =>
      expect(visit.window.document.activeElement?.textContent).toContain(m.release_fidelity_selected({}, o)),
    );
    expect(data.calls.filter((call) => call.path.includes('/subjects/'))).toHaveLength(3);
    expect(data.calls.some((call) => call.cursor === 'later')).toBe(true);
    expect(data.calls.find((call) => call.path.endsWith(source))?.session).toBeNull();
    expect(data.calls.every((call) => !oldSession || call.session !== oldSession)).toBe(true);
    expect(visit.host.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
    data.remove();
    data.calls.length = 0;
    await act(async () => {
      visit.window.dispatchEvent(new visit.window.Event('popstate'));
    });
    await eventually(() => expect(visit.host.textContent).toContain(m.release_fidelity_visit_changed({}, o)));
    expect(visit.host.querySelector('[data-slot="release-detail-facts"]') === null).toBe(true);
    expect(visit.host.querySelector('[data-slot="release-related"] h2') === visit.window.document.activeElement).toBe(
      true,
    );
    expect(data.calls.filter((call) => call.cursor)).toHaveLength(1);
  } finally {
    await visit.close();
  }
});

test('closed return intent rejects malformed addresses; changed native currentness drops the cursor and preserves the reading on destination failure', async () => {
  expect(() => releaseSearch({ context: 'bad' })).toThrow();
  expect(() => releaseSearch({ cursor: 'native-old' })).toThrow();
  const data = fixture(candidateContext);
  const page = await data.read('forward:rezics:releaseSupersedes', 'later');
  if (!page.ok || !page.stream) throw Error('Expected native release');
  const occurrence = occurrenceFor(page.rows[0]!, page.stream)!;
  const descriptor: ReleaseVisit = {
    id: source,
    context: candidateContext,
    digest: page.digest,
    revision: 1,
    stream: page.stream.key,
    cursor: 'later',
    occurrence: { ...occurrence, revision: 1 },
    focus: 'inspection',
  };
  const back = releaseReturnHref('Release', 'en', descriptor)!;
  expect(releaseVisitReturn(back + '&via=/arbitrary')).toBeUndefined();
  expect(releaseReturnHref('Release', 'en', { ...descriptor, cursor: '界'.repeat(4096) })).toBeUndefined();
  const parsed = releaseVisitFromHash(new URL(back, 'https://site.test').hash)!;
  data.subject.revision = 2;
  const fresh = await data.read(parsed.stream, parsed.cursor, parsed.occurrence?.target, undefined, parsed);
  expect(fresh.ok && fresh.returned).toBe('changed');
  expect(data.calls.at(-1)?.cursor).toBeNull();
  data.subject.revision = 1;
  data.failTarget();
  const visit = await mount(data, candidateContext, new URL(back, 'https://site.test').hash);
  try {
    expect(visit.host.querySelector('[data-slot="release-work"] a')?.getAttribute('href')).toContain('via=');
    expect(visit.host.textContent).toContain(m.release_fidelity_detail_unavailable({}, o));
    expect(visit.host.querySelectorAll('[data-slot="release-related"] ul > li')).toHaveLength(2);
    const sources = visit.host.querySelector<HTMLAnchorElement>('a[href*="/sources?"]')!;
    expect(new URL(sources.href).searchParams.get('via')).toContain('/release?context=');
    await visit.context(selectedContext);
    await eventually(() => expect(visit.host.querySelector('[data-slot="release-work"]') === null).toBe(true));
    await visit.context(candidateContext);
    await eventually(() => expect(visit.host.querySelector('[data-slot="release-work"]')).not.toBeNull());
    expect(visit.host.querySelector('[data-slot="release-detail-facts"]') === null).toBe(true);
  } finally {
    await visit.close();
  }
});

test('File visits use the disclosed Global handoff; a concealed return and a new tab never restore old evidence', async () => {
  const data = fixture(candidateContext, 'rezics:AnimeRelease');
  const visit = await mount(data, candidateContext);
  let hash = '';
  try {
    await visit.stream('forward:schema:associatedMedia');
    const link = visit.host.querySelector<HTMLAnchorElement>('[data-slot="release-related"] li a[href*="/file?"]')!;
    expect(link).not.toBeNull();
    const back = new URL(link.href).searchParams.get('via')!;
    hash = new URL(back, 'https://site.test').hash;
    expect(releaseVisitFromHash(hash)?.occurrence?.statementId).toBeTruthy();
    await visit.click(link);
    await act(async () => {
      visit.window.dispatchEvent(new visit.window.Event('popstate'));
    });
    await eventually(() => expect(visit.window.document.activeElement?.tagName).toBe('SUMMARY'));
    expect(visit.host.querySelector('[data-slot="release-occurrence-evidence"]')?.hasAttribute('open')).toBe(true);
    expect(visit.host.querySelector('[data-slot="release-detail-facts"]') === null).toBe(true);
    data.conceal();
    await act(async () => {
      visit.window.dispatchEvent(new visit.window.Event('popstate'));
    });
    await eventually(() => expect(visit.host.textContent).toContain(m.release_fidelity_visit_changed({}, o)));
    expect(visit.host.querySelector('[data-slot="release-related"] li a') === null).toBe(true);
    expect(visit.host.querySelector('[data-slot="release-occurrence-evidence"]') === null).toBe(true);
    expect(visit.host.querySelector('[data-slot="release-detail-facts"]') === null).toBe(true);
  } finally {
    await visit.close();
  }
  const next = fixture(candidateContext, 'bf:Instance');
  const tab = await mount(next, candidateContext);
  try {
    expect(tab.host.querySelector('[data-slot="release-detail"]')).toBeNull();
    expect(next.calls.every((call) => call.cursor === null && call.session === null)).toBe(true);
    expect(tab.host.querySelector('[data-slot="release-work"] a')).not.toBeNull();
    expect(releaseVisitFromHash(hash)?.id).toBe(source);
  } finally {
    await tab.close();
  }
});
